;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.client
  "WebSocket client to the Penforge daemon (`/agent`).

  Connection state lives under `[:penforge :connection]`:
  `{:status :disconnected|:pairing|:connected, :reason, :daemon-version,
  :attempt}`. `:pairing` means the socket is opening or waiting for
  `auth.ok`. Incoming messages are emitted as `::message` events (see
  `messages`) so every feature can follow them on the store stream.

  The pairing token comes from the pair route and lives only in
  `sessionStorage` (`penforge.token`); other tabs of the same origin
  can share it through the broadcast channel."
  (:require
   [app.common.logging :as log]
   [app.config :as cf]
   [app.main.broadcast :as mbc]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.auth :as-alias auth]
   [app.main.data.workspace.mcp :as mcp]
   [app.main.store :as st]
   [app.util.globals :as globals]
   [beicon.v2.core :as rx]
   [beicon.v2.operators :as rxo]
   [okulary.core :as l]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

(def default-agent-uri "ws://127.0.0.1:4410/agent")

(def token-key "penforge.token")

(def max-reconnect-attempts
  "Reconnect attempts after a lost or refused connection before the
  client gives up and waits for an explicit retry. Every refused
  attempt is logged by the browser, so the number stays small."
  6)

(defn enabled?
  "Check if the Penforge AI features are enabled."
  []
  (contains? cf/flags :ai))

(defn get-agent-uri
  "The daemon WebSocket URI; `penforgeAgentURI` in `config.js`
  overrides the default."
  []
  (or (unchecked-get globals/global "penforgeAgentURI")
      default-agent-uri))

;; --- Token storage (sessionStorage only, never localStorage)

(defn get-token
  []
  (try
    (some-> (unchecked-get globals/global "sessionStorage")
            (.getItem token-key)
            (not-empty))
    (catch :default _ nil)))

(defn- store-token
  [token]
  (try
    (some-> (unchecked-get globals/global "sessionStorage")
            (.setItem token-key token))
    (catch :default cause
      (log/warn :hint "unable to store the penforge token" :cause cause))))

(defn- clear-token
  []
  (try
    (some-> (unchecked-get globals/global "sessionStorage")
            (.removeItem token-key))
    (catch :default _ nil)))

(defn get-reconnect-delay
  "Backoff delay in ms for the given (zero based) reconnect attempt."
  [attempt]
  (min 30000 (* 1000 (js/Math.pow 2 attempt))))

;; --- Socket

(defonce ^:private current-socket
  (atom nil))

(defn- socket-open?
  [^js ws]
  (and (some? ws) (= 1 (.-readyState ws))))

(defn send!
  "Send a client message to the daemon. Returns true when the message
  was written to an authenticated socket."
  [message]
  (let [ws (deref current-socket)]
    (if (and (socket-open? ws)
             (= :connected (get-in @st/state [:penforge :connection :status])))
      (do
        (when *assert*
          (proto/check-client-message message))
        (.send ^js ws (proto/encode message))
        true)
      (do
        (log/warn :hint "penforge daemon not connected; message dropped"
                  :type (:type message))
        false))))

(defn send
  "Event that sends a client message to the daemon."
  [message]
  (ptk/reify ::send
    ptk/EffectEvent
    (effect [_ _ _]
      (send! message))))

(defn messages
  "Stream of decoded daemon messages, taken from the store stream."
  [stream]
  (->> stream
       (rx/filter (ptk/type? ::message))
       (rx/map deref)))

(defn- message
  [msg]
  (ptk/data-event ::message msg))

(declare connect)
(declare socket-closed)

(defn- set-connection
  [state attrs]
  (update-in state [:penforge :connection] merge attrs))

(defn- open-socket
  "Open the socket and return a stream of store events produced by it.
  Unsubscribing closes the socket."
  [uri token]
  (rx/create
   (fn [subs]
     (let [ws     (js/WebSocket. uri)
           opened (volatile! false)]
       (reset! current-socket ws)

       (set! (.-onopen ws)
             (fn [_]
               (vreset! opened true)
               (.send ws (proto/encode (proto/auth token)))))

       (set! (.-onmessage ws)
             (fn [event]
               (if-let [msg (proto/decode (.-data event))]
                 (rx/push! subs (message msg))
                 (log/warn :hint "invalid message from the penforge daemon"))))

       ;; The browser already logs the failed connection; `onclose`
       ;; follows every error, so the handling lives there.
       (set! (.-onerror ws) (fn [_] nil))

       (set! (.-onclose ws)
             (fn [event]
               (when (identical? ws @current-socket)
                 (reset! current-socket nil))
               (rx/push! subs (socket-closed @opened (.-code event)))
               (rx/end! subs)))

       (fn []
         (set! (.-onclose ws) nil)
         (set! (.-onmessage ws) nil)
         (when (identical? ws @current-socket)
           (reset! current-socket nil))
         (when (< (.-readyState ws) 2)
           (.close ws 1000)))))))

(defn- socket-closed
  [opened? code]
  (ptk/reify ::socket-closed
    ptk/UpdateEvent
    (update [_ state]
      (let [connection (get-in state [:penforge :connection])]
        (if (= :auth-error (:reason connection))
          state
          (set-connection state {:status :disconnected
                                 :reason (if opened? :closed :unreachable)
                                 :close-code code}))))

    ptk/WatchEvent
    (watch [_ state stream]
      (let [{:keys [reason attempt]} (get-in state [:penforge :connection])
            attempt (or attempt 0)]
        (if (or (= :auth-error reason)
                (>= attempt max-reconnect-attempts)
                (nil? (get-token)))
          (rx/empty)
          (->> (rx/timer (get-reconnect-delay attempt))
               (rx/map (fn [_] (connect {:attempt (inc attempt)})))
               (rx/take-until
                (rx/filter #(or (ptk/type? ::connect %)
                                (ptk/type? ::disconnect %))
                           stream))))))))

(defn connect
  "Open the connection to the daemon with the stored token. A new
  connection replaces the current one."
  ([] (connect nil))
  ([{:keys [attempt]}]
   (ptk/reify ::connect
     ptk/UpdateEvent
     (update [_ state]
       (if (get-token)
         (set-connection state {:status :pairing
                                :reason nil
                                :attempt (or attempt 0)})
         (set-connection state {:status :disconnected
                                :reason :no-token})))

     ptk/WatchEvent
     (watch [_ _ stream]
       (if-let [token (get-token)]
         (->> (open-socket (get-agent-uri) token)
              (rx/take-until
               (rx/filter #(or (ptk/type? ::connect %)
                               (ptk/type? ::disconnect %)
                               (ptk/type? ::auth/logged-out %))
                          stream)))
         (rx/empty))))))

(defn disconnect
  "Close the connection to the daemon."
  []
  (ptk/reify ::disconnect
    ptk/UpdateEvent
    (update [_ state]
      (if (= :auth-error (get-in state [:penforge :connection :reason]))
        (set-connection state {:status :disconnected})
        (set-connection state {:status :disconnected :reason :closed})))))

(defn- handle-auth-message
  [msg]
  (ptk/reify ::handle-auth-message
    ptk/UpdateEvent
    (update [_ state]
      (case (:type msg)
        "auth.ok"
        (set-connection state {:status :connected
                               :reason nil
                               :attempt 0
                               :daemon-version (:daemon-version msg)})

        "auth.error"
        (set-connection state {:status :disconnected
                               :reason :auth-error
                               :auth-error (:reason msg)})
        state))

    ptk/WatchEvent
    (watch [_ _ _]
      (case (:type msg)
        ;; `::connected` follows the state change, so listeners see the
        ;; connected status
        "auth.ok"    (rx/of (ptk/data-event ::connected {}))
        "auth.error" (rx/of (disconnect))
        (rx/empty)))

    ptk/EffectEvent
    (effect [_ _ _]
      (when (= "auth.error" (:type msg))
        (clear-token)))))

(defn save-token
  "Store a pairing token and share it with the other tabs of this
  origin, which connect with it."
  [token]
  (ptk/reify ::save-token
    ptk/EffectEvent
    (effect [_ _ _]
      (store-token token)
      (mbc/emit! :penforge/token token))))

(defn pair
  "Store a pairing token, share it and connect this tab."
  [token]
  (ptk/reify ::pair
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (save-token token)
             (connect)))))

(defn parse-pair-input
  "Extract the token from a pairing URL or a bare token typed by the
  user. Returns nil when nothing usable is found."
  [input]
  (let [input (some-> input str .trim)]
    (when (seq input)
      (if-let [[_ token] (re-find #"[?&]token=([^&#\s]+)" input)]
        (js/decodeURIComponent token)
        (when (re-matches #"[A-Za-z0-9._~-]+" input)
          input)))))

;; --- Tab context (`context.set`)

(defn get-persona
  "Persona of the profile (W05 stores `:penforge-persona`; same rule as
  `app.main.data.penforge/current-persona`); designer by default."
  [state]
  (let [persona (get-in state [:profile :props :penforge-persona])]
    (if (= "developer" (some-> persona name))
      :developer
      :designer)))

(defn get-platform
  "Platform of the current project. W05 keeps the loaded platforms under
  `[:penforge-project-settings <project-id>]` (`app.main.data.penforge`;
  switch to its `current-platform` once both branches are merged)."
  [state]
  (let [project-id (:current-project-id state)
        platform   (get-in state [:penforge-project-settings project-id])]
    (if (= "mobile" (some-> platform name))
      :mobile
      :web)))

(defn get-context
  "Build the `context.set` data of the open file, or nil when no file
  is open."
  [state]
  (let [file-id    (:current-file-id state)
        page-id    (:current-page-id state)
        project-id (:current-project-id state)
        team-id    (:current-team-id state)]
    (when (and file-id page-id project-id team-id)
      {:file-id file-id
       :file-name (get-in state [:files file-id :name])
       :project-id project-id
       :project-name (get-in state [:projects project-id :name])
       :team-id team-id
       :page-id page-id
       :persona (get-persona state)
       :platform (get-platform state)
       :mcp-session-id (get-in state [:mcp :session-id])})))

(def ^:private context-ref
  (l/derived get-context st/state =))

(def ^:private connected-ref
  (l/derived #(= :connected (get-in % [:penforge :connection :status])) st/state))

;; --- Lifecycle

(defn initialize
  "Start the daemon client for an open workspace."
  []
  (ptk/reify ::initialize
    ptk/UpdateEvent
    (update [_ state]
      (if (get-in state [:penforge :connection])
        state
        (set-connection state {:status :disconnected
                               :reason (if (get-token) :closed :no-token)})))

    ptk/WatchEvent
    (watch [_ state stream]
      (let [stopper-s (rx/merge
                       (rx/filter (ptk/type? ::finalize) stream)
                       (rx/filter (ptk/type? ::initialize) stream)
                       (rx/filter (ptk/type? ::auth/logged-out) stream))
            status    (get-in state [:penforge :connection :status])]
        (->> (rx/merge
              (if (and (get-token) (not= :connected status))
                (rx/of (connect))
                (rx/empty))

              (->> (messages stream)
                   (rx/filter #(contains? #{"auth.ok" "auth.error"} (:type %)))
                   (rx/map handle-auth-message))

              ;; Send the tab context once connected and whenever it
              ;; changes (page, MCP session, persona...).
              (->> (rx/from-atom connected-ref {:emit-current-value? true})
                   (rx/combine-latest-with
                    (rx/from-atom context-ref {:emit-current-value? true}))
                   (rx/filter (fn [[connected? context]]
                                (and connected? (some? context))))
                   (rx/map second)
                   (rx/pipe (rxo/distinct-contiguous))
                   (rx/map (comp send proto/context-set)))

              ;; Connect the hidden MCP plugin to the daemon bridge each
              ;; time the daemon pairs, so its tools reach this tab.
              (->> (rx/from-atom connected-ref {:emit-current-value? true})
                   (rx/pipe (rxo/distinct-contiguous))
                   (rx/filter true?)
                   (rx/filter (fn [_]
                                (not (get-in @st/state [:mcp :connection-requested]))))
                   (rx/map (fn [_] (mcp/connect-mcp))))

              ;; A tab that pairs shares the token with the others.
              (->> mbc/stream
                   (rx/filter (mbc/type? :penforge/token))
                   (rx/map deref)
                   (rx/filter string?)
                   (rx/filter #(not= % (get-token)))
                   (rx/map (fn [token]
                             (store-token token)
                             (connect))))

              ;; Answer token requests from tabs opened without one.
              (->> mbc/stream
                   (rx/filter (mbc/type? :penforge/token-request))
                   (rx/tap (fn [_]
                             (when-let [token (get-token)]
                               (mbc/emit! :penforge/token token))))
                   (rx/ignore)))
             (rx/take-until stopper-s))))

    ptk/EffectEvent
    (effect [_ _ _]
      (when-not (get-token)
        (mbc/emit! :penforge/token-request nil)))))

(defn finalize
  "Stop the daemon client (workspace closed)."
  []
  (ptk/reify ::finalize
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (disconnect)))))
