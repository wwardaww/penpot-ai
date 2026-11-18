;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.penforge.embedded.redis
  "In-process replacement of the redis server, for the single-user
  desktop mode (Penforge desktop app, no Valkey/Redis process).

  Selected with `PENPOT_REDIS_URI=mem://<name>`. It implements the
  `app.redis` connection protocols, so every caller of `app.redis`
  (msgbus, job queue, dispatcher, rate limits, login lockout, MCP OAuth
  state, caches) works unchanged inside one backend process.

  Supported: strings with TTL (GET, SET with EX/PX/NX/XX/KEEPTTL, DEL,
  EXPIRE, SCAN), lists (RPUSH, blocking LPOP over several keys),
  hashes (HGET), PUBLISH/SUBSCRIBE and the Lua scripts the backend
  ships, ported to Clojure (EVAL of any other script raises). Data
  lives only in memory: it is lost when the backend stops, which is
  what the backend expects from redis (queues and caches are rebuilt
  from the database)."
  (:require
   [app.common.exceptions :as ex]
   [app.common.logging :as l]
   [app.redis :as rds]
   [app.redis.script :as-alias rscript]
   [cuerdas.core :as str])
  (:import
   clojure.lang.MapEntry
   io.lettuce.core.codec.StringCodec
   io.lettuce.core.protocol.CommandArgs
   io.lettuce.core.pubsub.RedisPubSubListener
   io.lettuce.core.SetArgs
   java.lang.AutoCloseable
   java.time.Duration))

(set! *warn-on-reflection* true)

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; STORE
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn create-store
  "Create an empty store. `clock` returns the current time in
  milliseconds (tests pass their own)."
  [& {:keys [clock] :or {clock #(System/currentTimeMillis)}}]
  {::lock (Object.)
   ::data (atom {})
   ::subscribers (atom {})
   ::clock clock})

(defn store?
  [o]
  (and (map? o) (contains? o ::data) (contains? o ::lock)))

(defmacro ^:private with-lock
  [store & body]
  `(locking (::lock ~store) ~@body))

(defn- now-ms
  [store]
  ((::clock store)))

(defn- wrong-type!
  [key]
  (ex/raise :type :internal
            :code ::wrong-type
            :hint (str "WRONGTYPE operation against key '" key "' holding the wrong kind of value")))

(defn- live-entry
  "Return the entry stored under `key`, or nil when it is missing or
  expired (an expired entry is removed). Call it with the lock held."
  [store key]
  (when-let [entry (get @(::data store) key)]
    (let [expire-at (:expire-at entry)]
      (if (and (some? expire-at) (<= expire-at (now-ms store)))
        (do (swap! (::data store) dissoc key) nil)
        entry))))

(defn- typed-value
  "Return the value of a live entry of type `type`, nil when missing."
  [store key type]
  (when-let [entry (live-entry store key)]
    (if (= type (:type entry))
      (:value entry)
      (wrong-type! key))))

(defn- put-entry!
  [store key entry]
  (swap! (::data store) assoc key entry))

(defn- format-number
  "Format a number the way the Lua scripts of redis store it: integers
  without decimals."
  [n]
  (let [n (double n)]
    (if (== n (Math/floor n))
      (str (long n))
      (str n))))

(defn- parse-number
  [v]
  (when (some? v)
    (Double/parseDouble (str v))))

;; --- strings

(defn get-string
  [store key]
  (with-lock store
    (typed-value store key :string)))

(defn set-string
  "SET with the options `:ex` (seconds), `:px` (milliseconds), `:nx`,
  `:xx` and `:keep-ttl`. Answers \"OK\", or nil when NX/XX refused the
  write."
  [store key val {:keys [ex px nx xx keep-ttl]}]
  (with-lock store
    (let [current (live-entry store key)]
      (cond
        (and nx (some? current)) nil
        (and xx (nil? current)) nil
        :else
        (let [now       (now-ms store)
              expire-at (cond
                          (some? ex) (+ now (* 1000 (long ex)))
                          (some? px) (+ now (long px))
                          keep-ttl   (:expire-at current)
                          :else      nil)]
          (put-entry! store key {:type :string :value val :expire-at expire-at})
          "OK")))))

(defn incr
  [store key]
  (with-lock store
    (let [current (live-entry store key)
          value   (if current
                    (if (= :string (:type current))
                      (Long/parseLong (:value current))
                      (wrong-type! key))
                    0)
          result  (inc value)]
      (put-entry! store key {:type :string
                             :value (str result)
                             :expire-at (:expire-at current)})
      result)))

(defn del
  [store keys]
  (with-lock store
    (reduce (fn [total key]
              (if (live-entry store key)
                (do (swap! (::data store) dissoc key)
                    (inc total))
                total))
            0
            keys)))

(defn expire
  "Set a TTL of `seconds`; a value <= 0 deletes the key like redis
  does. Answers true when the key exists."
  [store key seconds]
  (with-lock store
    (if (live-entry store key)
      (do
        (if (pos? seconds)
          (swap! (::data store) assoc-in [key :expire-at]
                 (+ (now-ms store) (* 1000 (long seconds))))
          (swap! (::data store) dissoc key))
        true)
      false)))

(defn- glob->regex
  "Translate a redis glob pattern (`*`, `?`, `[...]`, `\\x`) to a regex."
  [pattern]
  (let [sb (StringBuilder.)]
    (loop [chars (seq pattern)]
      (when-let [c (first chars)]
        (case c
          \* (do (.append sb ".*") (recur (rest chars)))
          \? (do (.append sb ".") (recur (rest chars)))
          \[ (do (.append sb "[") (recur (rest chars)))
          \] (do (.append sb "]") (recur (rest chars)))
          \\ (do (when-let [n (second chars)]
                   (.append sb (java.util.regex.Pattern/quote (str n))))
                 (recur (drop 2 chars)))
          (do (.append sb (java.util.regex.Pattern/quote (str c)))
              (recur (rest chars))))))
    (re-pattern (str sb))))

(defn scan
  "Answer every live key matching `pattern` in one page (cursor \"0\")."
  [store pattern]
  (with-lock store
    (let [regex (glob->regex pattern)
          found (->> (keys @(::data store))
                     (filter #(live-entry store %))
                     (filter #(re-matches regex %))
                     (sort)
                     (vec))]
      (MapEntry/create "0" found))))

;; --- hashes

(defn hget
  [store key field]
  (with-lock store
    (get (typed-value store key :hash) field)))

(defn hset
  [store key field-values]
  (with-lock store
    (let [current (live-entry store key)
          value   (if current
                    (if (= :hash (:type current))
                      (:value current)
                      (wrong-type! key))
                    {})]
      (put-entry! store key {:type :hash
                             :value (into value field-values)
                             :expire-at (:expire-at current)})
      (count field-values))))

;; --- lists

(defn rpush
  [store key elements]
  (with-lock store
    (let [current (live-entry store key)
          value   (if current
                    (if (= :list (:type current))
                      (:value current)
                      (wrong-type! key))
                    [])
          value   (into value elements)]
      (put-entry! store key {:type :list :value value :expire-at (:expire-at current)})
      (.notifyAll ^Object (::lock store))
      (count value))))

(defn- lpop-first
  "Pop the head of the first non empty list of `keys`. Lock held."
  [store keys]
  (some (fn [key]
          (when-let [value (seq (typed-value store key :list))]
            (let [rest-items (vec (rest value))]
              (if (empty? rest-items)
                (swap! (::data store) dissoc key)
                (swap! (::data store) assoc-in [key :value] rest-items))
              (MapEntry/create key (first value)))))
        keys))

(defn blpop
  "Blocking pop over `keys`. `timeout` is in seconds (a double); 0 waits
  forever, like redis. Answers a [key value] entry, or nil on timeout.
  The wait is interruptible."
  [store keys timeout]
  (let [lock     (::lock store)
        wait-ms  (long (* 1000 (double timeout)))
        deadline (when (pos? wait-ms) (+ (System/currentTimeMillis) wait-ms))]
    (locking lock
      (loop []
        (if-let [result (lpop-first store keys)]
          result
          (if (nil? deadline)
            (do (.wait ^Object lock) (recur))
            (let [remaining (- deadline (System/currentTimeMillis))]
              (when (pos? remaining)
                (.wait ^Object lock (long remaining))
                (recur)))))))))

;; --- pub/sub

(defn publish
  "Deliver `message` to every subscriber of `topic`, on the caller's
  thread. Answers the number of subscribers that received it."
  [store topic message]
  (let [subs (get @(::subscribers store) topic)]
    (doseq [deliver subs]
      (try
        (deliver topic message)
        (catch Throwable cause
          (l/err :hint "error delivering a message" :topic topic :cause cause))))
    (count subs)))

(defn- subscribe!
  [store topic deliver]
  (swap! (::subscribers store) update topic (fnil conj #{}) deliver))

(defn- unsubscribe!
  [store topic deliver]
  (swap! (::subscribers store)
         (fn [subs]
           (let [remaining (disj (get subs topic #{}) deliver)]
             (if (empty? remaining)
               (dissoc subs topic)
               (assoc subs topic remaining))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; SCRIPTS (ports of the Lua scripts in src/app/**/*.lua)
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defmulti run-script
  "Run a script by its `::rscript/name`. Results follow the redis Lua
  conversion: numbers are truncated to integers, true is 1 and false
  is nil."
  (fn [_store script] (::rscript/name script)))

(defmethod run-script :default
  [_ script]
  (ex/raise :type :internal
            :code ::script-not-supported
            :hint (str "script not supported by the embedded redis: "
                       (::rscript/name script))))

(defn- script-args
  [script]
  [(vec (::rscript/keys script))
   (mapv str (::rscript/vals script))])

;; app/rpc/rlimit/bucket.lua
(defmethod run-script :app.rpc.rlimit/bucket-rate-limit
  [store script]
  (let [[[key] [interval rate capacity timestamp requested]] (script-args script)]
    (with-lock store
      (let [interval  (parse-number interval)
            rate      (parse-number rate)
            capacity  (parse-number capacity)
            timestamp (parse-number timestamp)
            requested (or (parse-number requested) 1.0)
            fill-time (/ capacity (/ rate interval))
            ttl       (long (Math/floor (* fill-time 2)))
            last      (or (parse-number (hget store key "tokens")) capacity)
            refreshed (or (parse-number (hget store key "timestamp")) 0.0)
            delta     (max 0.0 (/ (- timestamp refreshed) interval))
            filled    (min capacity (+ last (Math/floor (* delta rate))))
            allowed?  (>= filled requested)
            tokens    (if allowed? (- filled requested) filled)]
        (when allowed?
          (hset store key {"tokens" (format-number tokens)
                           "timestamp" (format-number timestamp)}))
        (expire store key ttl)
        [(when allowed? 1) (long tokens)]))))

;; app/rpc/rlimit/window.lua
(defmethod run-script :app.rpc.rlimit/window-rate-limit
  [store script]
  (let [[[key] [nreq ttl]] (script-args script)]
    (with-lock store
      (let [nreq      (long (parse-number nreq))
            total     (incr store key)
            _         (expire store key (long (parse-number ttl)))
            remaining (max 0 (- nreq total))]
        [(when (<= total nreq) 1) remaining]))))

;; app/auth/login_lockout.lua
(defmethod run-script :app.auth.login-lockout/login-lockout
  [store script]
  (let [[[key] [threshold window-ms now-ms]] (script-args script)]
    (with-lock store
      (let [threshold  (long (parse-number threshold))
            window-ms  (long (parse-number window-ms))
            now        (long (parse-number now-ms))
            window-sec (long (Math/ceil (/ window-ms 1000.0)))
            value      (get-string store key)
            [count start]
            (if-let [sep (some-> value (str/index-of ":"))]
              [(Long/parseLong (subs value 0 sep))
               (Long/parseLong (subs value (inc sep)))]
              [0 now])
            [count start] (if (> (- now start) window-ms) [0 now] [count start])
            count      (inc count)
            locked?    (>= count threshold)]
        (set-string store key (str count ":" start) {:ex window-sec})
        [count
         (if locked? 1 0)
         (if locked?
           (long (Math/ceil (/ (- window-ms (- now start)) 1000.0)))
           0)]))))

;; app/mcp/oauth_state.lua
(defmethod run-script :app.mcp.oauth-state/compare-and-update
  [store script]
  (let [[[key] [expected replacement]] (script-args script)]
    (with-lock store
      (if (not= expected (get-string store key))
        [0]
        (do
          (if (= "" replacement)
            (del store [key])
            (set-string store key replacement {:keep-ttl true}))
          [1])))))

;; app/mcp/oauth_rate.lua
(defmethod run-script :app.mcp.oauth-state/rate
  [store script]
  (let [[[key] [ttl]] (script-args script)]
    (with-lock store
      (let [count (incr store key)]
        (when (= 1 count)
          (expire store key (long (parse-number ttl))))
        [count]))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; CONNECTIONS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn set-args->options
  "Read the options of a Lettuce `SetArgs` (what `app.redis/set` hands
  to the connection) back into a map."
  [^SetArgs args]
  (if (nil? args)
    {}
    (let [cargs  (CommandArgs. StringCodec/UTF8)
          _      (.build args cargs)
          tokens (->> (str/split (str/trim (.toCommandString cargs)) #"\s+")
                      (remove str/blank?)
                      (vec))]
      (loop [tokens tokens
             result {}]
        (if-let [token (first tokens)]
          (case (str/upper token)
            "EX"      (recur (drop 2 tokens) (assoc result :ex (Long/parseLong (second tokens))))
            "PX"      (recur (drop 2 tokens) (assoc result :px (Long/parseLong (second tokens))))
            "NX"      (recur (rest tokens) (assoc result :nx true))
            "XX"      (recur (rest tokens) (assoc result :xx true))
            "KEEPTTL" (recur (rest tokens) (assoc result :keep-ttl true))
            (ex/raise :type :internal
                      :code ::set-option-not-supported
                      :hint (str "SET option not supported by the embedded redis: " token)))
          result)))))

(deftype Connection [store ^:volatile-mutable ^Duration timeout ^Duration default-timeout]
  AutoCloseable
  (close [_])

  rds/IConnection
  (-set-timeout [_ value]
    (set! timeout value))

  (-reset-timeout [_]
    (set! timeout default-timeout))

  (-get-timeout [_]
    timeout)

  rds/IDefaultConnection
  (-publish [_ topic message]
    (long (publish store topic message)))

  (-rpush [_ key elements]
    (long (rpush store key elements)))

  (-blpop [_ keys timeout]
    (blpop store keys timeout))

  (-get [_ key]
    (get-string store key))

  (-scan [_ _cursor pattern _limit]
    (scan store pattern))

  (-hget [_ key field]
    (hget store key field))

  (-set [_ key val args]
    (set-string store key val (set-args->options args)))

  (-del [_ keys]
    (long (del store keys)))

  (-expire [_ key seconds]
    (expire store key seconds))

  (-ping [_]
    "PONG")

  (-eval [_ script]
    (run-script store script)))

(deftype SubscriptionConnection [store listeners topics deliver
                                 ^:volatile-mutable ^Duration timeout
                                 ^Duration default-timeout]
  AutoCloseable
  (close [_]
    (doseq [topic @topics]
      (unsubscribe! store topic deliver))
    (reset! topics #{}))

  rds/IConnection
  (-set-timeout [_ value]
    (set! timeout value))

  (-reset-timeout [_]
    (set! timeout default-timeout))

  (-get-timeout [_]
    timeout)

  rds/IPubSubConnection
  (-add-listener [_ listener]
    (swap! listeners conj listener))

  (-subscribe [_ new-topics]
    (doseq [topic new-topics]
      (when-not (contains? @topics topic)
        (swap! topics conj topic)
        (subscribe! store topic deliver)
        (doseq [^RedisPubSubListener listener @listeners]
          (.subscribed listener ^String topic (long (count @topics)))))))

  (-unsubscribe [_ old-topics]
    (doseq [topic old-topics]
      (when (contains? @topics topic)
        (swap! topics disj topic)
        (unsubscribe! store topic deliver)
        (doseq [^RedisPubSubListener listener @listeners]
          (.unsubscribed listener ^String topic (long (count @topics))))))))

(defn connect
  [store ^Duration timeout]
  (->Connection store timeout timeout))

(defn connect-pubsub
  [store ^Duration timeout]
  (let [listeners (atom [])
        deliver   (fn [topic message]
                    (doseq [^RedisPubSubListener listener @listeners]
                      (.message listener ^String topic ^String message)))]
    (->SubscriptionConnection store listeners (atom #{}) deliver timeout timeout)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; CLIENT (used by app.redis when the uri scheme is `mem`)
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn create-client
  "Build the client state `app.redis` keeps under `::rds/client`."
  [{:keys [::rds/uri]}]
  (l/inf :hint "using the embedded in-memory redis (single-user mode)"
         :uri (str uri))
  (let [store (create-store)]
    {::rds/embedded {:connect (fn [timeout] (connect store timeout))
                     :connect-pubsub (fn [timeout] (connect-pubsub store timeout))
                     :store store}
     ::rds/cache (atom {})
     ::rds/timeout rds/default-timeout}))
