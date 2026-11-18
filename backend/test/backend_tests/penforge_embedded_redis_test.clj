;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.penforge-embedded-redis-test
  "The embedded store replaces the redis server in the single-user
  desktop mode. These tests drive it through the `app.redis` API, the
  same way the msgbus, the job queue and the rate limits do."
  (:require
   [app.common.time :as ct]
   [app.common.uri :as u]
   [app.metrics :as mtx]
   [app.msgbus :as mbus]
   [app.penforge.embedded.redis :as emb]
   [app.redis :as rds]
   [app.redis.script :as-alias rscript]
   [app.worker :as wrk]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [integrant.core :as ig]
   [promesa.exec.csp :as sp])
  (:import
   java.util.concurrent.Executors))

(defn- manual-clock
  "A clock the test moves by hand; answers milliseconds."
  []
  (let [now (atom 1000000)]
    {:clock (fn [] @now)
     :advance! (fn [ms] (swap! now + ms))}))

(defn- connection
  ([] (connection (emb/create-store)))
  ([store] (emb/connect store rds/default-timeout)))

(defn- embedded-client
  []
  (ig/init-key ::rds/client {::rds/uri (u/uri "mem://test")
                             ::rds/timeout (ct/duration "10s")}))

;; --- strings

(t/deftest get-set-del
  (let [conn (connection)]
    (t/is (nil? (rds/get conn "a")))
    (t/is (= "OK" (rds/set conn "a" "1")))
    (t/is (= "1" (rds/get conn "a")))
    (t/is (= 1 (rds/del conn ["a" "missing"])))
    (t/is (nil? (rds/get conn "a")))))

(t/deftest set-options-come-through-set-args
  ;; app.redis/set turns the option map into a Lettuce SetArgs before it
  ;; reaches the connection; the store reads it back.
  (t/is (= {:ex 10 :nx true} (emb/set-args->options (rds/build-set-args {:ex 10 :nx true}))))
  (t/is (= {:px 250} (emb/set-args->options (rds/build-set-args {:px 250}))))
  (t/is (= {:keep-ttl true} (emb/set-args->options (rds/build-set-args {:keep-ttl true}))))
  (let [conn (connection)]
    (t/is (= "OK" (rds/set conn "k" "v1" {:ex 60 :nx true})))
    (t/is (nil? (rds/set conn "k" "v2" {:ex 60 :nx true})) "NX refuses an existing key")
    (t/is (= "v1" (rds/get conn "k")))))

(t/deftest keys-expire
  (let [{:keys [clock advance!]} (manual-clock)
        conn (connection (emb/create-store :clock clock))]
    (rds/set conn "short" "x" {:ex 2})
    (rds/set conn "kept" "y")
    (t/is (true? (rds/expire conn "kept" 5)))
    (t/is (false? (rds/expire conn "missing" 5)))
    (advance! 1999)
    (t/is (= "x" (rds/get conn "short")))
    (advance! 1)
    (t/is (nil? (rds/get conn "short")))
    (t/is (= "y" (rds/get conn "kept")))
    (advance! 3000)
    (t/is (nil? (rds/get conn "kept")))))

(t/deftest keep-ttl-keeps-the-expiration
  (let [{:keys [clock advance!]} (manual-clock)
        conn (connection (emb/create-store :clock clock))]
    (rds/set conn "k" "a" {:ex 10})
    (advance! 5000)
    (rds/set conn "k" "b" {:keep-ttl true})
    (advance! 4999)
    (t/is (= "b" (rds/get conn "k")))
    (advance! 1)
    (t/is (nil? (rds/get conn "k")))))

(t/deftest scan-matches-glob-patterns
  (let [conn (connection)]
    (rds/set conn "penpot.export.1" "a")
    (rds/set conn "penpot.export.2" "b")
    (rds/set conn "penpot.other" "c")
    (let [[cursor ks] (rds/scan conn "0" "penpot.export.*" 100)]
      (t/is (= "0" cursor))
      (t/is (= ["penpot.export.1" "penpot.export.2"] ks)))))

(t/deftest wrong-type-raises
  (let [conn (connection)]
    (rds/rpush conn "list" ["a"])
    (t/is (thrown? clojure.lang.ExceptionInfo (rds/get conn "list")))))

;; --- lists

(t/deftest rpush-and-blpop-keep-order
  (let [conn (connection)]
    (t/is (= 2 (rds/rpush conn "q" ["a" "b"])))
    (t/is (= 3 (rds/rpush conn "q" ["c"])))
    (t/is (= ["q" "a"] (vec (rds/blpop conn ["q"] 1000))))
    (t/is (= ["q" "b"] (vec (rds/blpop conn ["q"] 1000))))
    (t/is (= ["q" "c"] (vec (rds/blpop conn ["q"] 1000))))))

(t/deftest blpop-takes-the-first-non-empty-key
  (let [conn (connection)]
    (rds/rpush conn "second" ["x"])
    (t/is (= ["second" "x"] (vec (rds/blpop conn ["first" "second"] 1000))))))

(t/deftest blpop-times-out-with-nil
  (let [conn  (connection)
        start (System/currentTimeMillis)]
    (t/is (nil? (rds/blpop conn ["empty"] 200)))
    (t/is (>= (- (System/currentTimeMillis) start) 190))))

(t/deftest blpop-wakes-up-on-rpush
  (let [store  (emb/create-store)
        result (future (rds/blpop (connection store) ["jobs"] 5000))]
    (Thread/sleep 100)
    (rds/rpush (connection store) "jobs" ["payload"])
    (t/is (= ["jobs" "payload"] (vec (deref result 2000 ::timeout))))))

(t/deftest blpop-is-interruptible
  ;; The job runner thread is stopped with an interrupt while it waits.
  (let [conn   (connection)
        caught (promise)
        thread (Thread. (fn []
                          (try
                            (rds/blpop conn ["never"] 0)
                            (catch InterruptedException _
                              (deliver caught true)))))]
    (.start thread)
    (Thread/sleep 100)
    (.interrupt thread)
    (t/is (true? (deref caught 2000 false)))))

;; --- pub/sub

(t/deftest publish-reaches-subscribers
  (let [store    (emb/create-store)
        sconn    (emb/connect-pubsub store rds/default-timeout)
        received (atom [])]
    (rds/add-listener sconn {:on-message (fn [_ topic message]
                                           (swap! received conj [topic message]))})
    (rds/subscribe sconn ["t1"])
    (t/is (= 1 (rds/publish (connection store) "t1" "hello")))
    (t/is (= 0 (rds/publish (connection store) "t2" "nobody")))
    (rds/unsubscribe sconn ["t1"])
    (t/is (= 0 (rds/publish (connection store) "t1" "gone")))
    (t/is (= [["t1" "hello"]] @received))))

(t/deftest msgbus-runs-on-the-embedded-client
  (let [client   (embedded-client)
        executor (Executors/newSingleThreadExecutor)
        bus      (ig/init-key ::mbus/msgbus {::mbus/buffer-size 16
                                             ::mbus/timeout (ct/duration "5s")
                                             ::rds/client client
                                             ::wrk/executor executor
                                             ::mtx/metrics (th/metrics-stub)})]
    (try
      (let [ch (sp/chan :buf 4)]
        (mbus/sub! bus :topic "file-1" :chan ch)
        ;; subscriptions are applied asynchronously by an agent
        (Thread/sleep 200)
        (mbus/pub! bus :topic "file-1" :message {:type :file-change :revn 2})
        (let [[msg _] (sp/alts! [ch (sp/timeout-chan 2000)])]
          (t/is (= {:type :file-change :revn 2 :topic "file-1"} msg))))
      (finally
        (ig/halt-key! ::mbus/msgbus bus)
        (ig/halt-key! ::rds/client client)
        (.shutdownNow executor)))))

(t/deftest pool-and-run-work-with-the-embedded-client
  (let [client (embedded-client)
        cfg    {::rds/client client ::mtx/metrics (th/metrics-stub)}
        pool   (rds/pool cfg)]
    (try
      (rds/run! {::rds/pool pool}
                (fn [{:keys [::rds/conn]}]
                  (rds/set conn "k" "v")))
      (t/is (= "v" (rds/run! {::rds/pool pool}
                             (fn [{:keys [::rds/conn]}]
                               (rds/get conn "k")))))
      (finally
        (.close ^java.lang.AutoCloseable pool)))))

;; --- scripts

(defn- script
  [sname keys vals]
  {::rscript/name sname
   ::rscript/path "unused.lua"
   ::rscript/keys keys
   ::rscript/vals vals})

(t/deftest window-rate-limit-script
  (let [conn (connection)
        run  #(rds/eval conn (script :app.rpc.rlimit/window-rate-limit ["w"] [2 60]))]
    (t/is (= [1 1] (run)))
    (t/is (= [1 0] (run)))
    (t/is (= [nil 0] (run)))))

(t/deftest bucket-rate-limit-script
  ;; interval 1s, rate 1 token per interval, capacity 2
  (let [conn (connection)
        run  (fn [ts] (rds/eval conn (script :app.rpc.rlimit/bucket-rate-limit ["b"] [1 1 2 ts])))]
    (t/is (= [1 1] (run 100)))
    (t/is (= [1 0] (run 100)))
    (t/is (= [nil 0] (run 100)))
    (t/is (= [1 0] (run 101)) "one interval later one token came back")))

(t/deftest login-lockout-script
  (let [conn (connection)
        now  1700000000000
        run  (fn [ts] (rds/eval conn (script :app.auth.login-lockout/login-lockout
                                             ["lock"] [3 60000 ts])))]
    (t/is (= [1 0 0] (run now)))
    (t/is (= [2 0 0] (run (+ now 1000))))
    (t/is (= [3 1 58] (run (+ now 2000))))
    (t/is (= (str 3 ":" now) (rds/get conn "lock")))
    (t/is (= [1 0 0] (run (+ now 61000))) "a new window starts the count again")))

(t/deftest oauth-state-scripts
  (let [conn (connection)
        cas  (fn [expected replacement]
               (rds/eval conn (script :app.mcp.oauth-state/compare-and-update
                                      ["state"] [expected replacement])))]
    (rds/set conn "state" "a" {:ex 60})
    (t/is (= [0] (cas "other" "b")))
    (t/is (= [1] (cas "a" "b")))
    (t/is (= "b" (rds/get conn "state")))
    (t/is (= [1] (cas "b" "")))
    (t/is (nil? (rds/get conn "state"))))
  (let [conn (connection)
        rate #(rds/eval conn (script :app.mcp.oauth-state/rate ["r"] [60]))]
    (t/is (= [1] (rate)))
    (t/is (= [2] (rate)))))

(t/deftest unknown-scripts-raise
  (t/is (thrown? clojure.lang.ExceptionInfo
                 (rds/eval (connection) (script :some/other [] [])))))
