;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.apps
  "Built apps on the dashboard (W33).

  The dashboard's Apps section talks to the Penforge daemon over the
  same client as the workspace (`app.main.data.ai.client`), without a
  `context.set`: `apps.list` lists the apps of this computer, `apps.start`
  / `apps.stop` run their dev servers, `apps.logs` reads the output and
  `apps.phone.start` / `apps.phone.stop` open an Expo app on a phone
  after the user agreed to the local network access.

  State lives under `[:penforge :apps]`:
  `{:status :loading|:loaded|:failed, :team-id, :rid, :items {id app},
  :order [id], :error {:code :message}, :errors {id {:code :message}},
  :pending #{id}, :logs {id {:loading :lines}}, :phone {id phone},
  :rids {rid [kind id]}}`. App maps are the daemon's `AppInfo` with
  kebab-case keys (`:project-id`, `:status {:state :url ...}`)."
  (:require
   [app.common.logging :as log]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

;; --- Pure helpers

(defn safe-app-url?
  "True for the loopback HTTP URLs the daemon hands out for dev servers;
  nothing else is ever opened."
  [url]
  (and (string? url)
       (boolean (re-matches #"http://(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(/.*)?" url))))

(defn live?
  "True while the app's dev server starts or runs."
  [app]
  (contains? #{"starting" "ready"} (get-in app [:status :state])))

(defn ready-url
  "The URL of a running app, when it is safe to open."
  [app]
  (let [{:keys [state url]} (:status app)]
    (when (and (= state "ready") (safe-app-url? url))
      url)))

(defn- app-entry?
  [app]
  (and (map? app) (string? (:project-id app)) (string? (:name app))))

(defn- state-path
  [& ks]
  (into [:penforge :apps] ks))

(defn- remember-rid
  [state rid kind project-id]
  (assoc-in state (state-path :rids rid) [kind project-id]))

(defn apply-message
  "Apply a daemon message to the state; returns the state unchanged for
  messages that are not about the apps."
  [state {:keys [type rid project-id] :as msg}]
  (case type
    "apps.list"
    (if (= rid (get-in state (state-path :rid)))
      (let [apps (filterv app-entry? (:apps msg))]
        (update-in state [:penforge :apps] merge
                   {:status :loaded
                    :error nil
                    :items (into {} (map (juxt :project-id identity)) apps)
                    :order (mapv :project-id apps)}))
      state)

    "apps.status"
    (cond-> state
      (contains? (get-in state (state-path :items)) project-id)
      (assoc-in (state-path :items project-id :status)
                (select-keys msg [:state :url :reason :message :exposure]))

      :always
      (update-in (state-path :pending) disj project-id)

      (contains? #{"ready" "starting"} (:state msg))
      (update-in (state-path :errors) dissoc project-id))

    "apps.logs"
    (assoc-in state (state-path :logs project-id)
              {:loading false
               :lines (filterv #(string? (:text %)) (:lines msg))})

    "apps.phone"
    (assoc-in state (state-path :phone project-id)
              (select-keys msg [:state :url :host :port :qr :expires-at :code :message]))

    "error"
    (if-let [[kind id] (get-in state (state-path :rids rid))]
      (let [error (select-keys msg [:code :message])
            state (update-in state (state-path :rids) dissoc rid)]
        (case kind
          :list  (update-in state [:penforge :apps] merge {:status :failed :error error})
          :phone (assoc-in state (state-path :phone id) {:state "failed"
                                                         :code (:code msg)
                                                         :message (:message msg)})
          :logs  (assoc-in state (state-path :logs id) {:loading false :lines [] :error error})
          (-> state
              (assoc-in (state-path :errors id) error)
              (update-in (state-path :pending) disj id))))
      state)

    state))

;; --- Browser tabs opened for apps that are still starting

;; Opening a tab only works inside the click handler, so the tab opens
;; at once with a short notice and goes to the app once it is ready.
(defonce ^:private waiting-tabs
  (atom {}))

(defn open-waiting-tab!
  "Open an empty browser tab showing a short starting notice; returns
  the window, or nil when the browser blocked it."
  []
  (when-let [^js tab (.open js/window "" "_blank")]
    (try
      ;; the app must not reach back into the dashboard
      (set! (.-opener tab) nil)
      (let [^js doc (.-document tab)]
        (set! (.-title doc) (tr "penforge.apps.tab.starting"))
        (set! (.. doc -body -textContent) (tr "penforge.apps.tab.starting")))
      (catch :default cause
        (log/warn :hint "unable to write the waiting tab" :cause cause)))
    tab))

(defn- settle-waiting-tab!
  [project-id state url]
  (when-let [^js tab (get @waiting-tabs project-id)]
    (cond
      (and (= state "ready") (safe-app-url? url))
      (do (swap! waiting-tabs dissoc project-id)
          (set! (.-location tab) url))

      (contains? #{"failed" "stopped"} state)
      (do (swap! waiting-tabs dissoc project-id)
          (.close tab)))))

(defn- drop-waiting-tab!
  [project-id]
  (when-let [^js tab (get @waiting-tabs project-id)]
    (swap! waiting-tabs dissoc project-id)
    (.close tab)))

;; --- Events

(declare fetch-apps)

(defn- handle-message
  [msg]
  (ptk/reify ::handle-message
    ptk/UpdateEvent
    (update [_ state]
      (apply-message state msg))

    ptk/EffectEvent
    (effect [_ state _]
      (case (:type msg)
        "apps.status"
        (when-not (= "restarting" (:reason msg))
          (settle-waiting-tab! (:project-id msg) (:state msg) (:url msg)))
        "error"
        ;; a refused start closes the tab it opened
        (doseq [project-id (keys @waiting-tabs)]
          (when (get-in state (state-path :errors project-id))
            (drop-waiting-tab! project-id)))
        nil))))

(defn- request
  "Send a request; on a closed connection mark it failed right away."
  [state kind project-id message]
  (if (client/send! message)
    (remember-rid state (:rid message) kind project-id)
    (case kind
      :list (update-in state [:penforge :apps] merge
                       {:status :failed :error {:code "not-connected"}})
      (-> state
          (assoc-in (state-path :errors project-id) {:code "not-connected"})
          (update-in (state-path :pending) disj project-id)))))

(defn fetch-apps
  "Ask the daemon for the built apps of the dashboard's team."
  []
  (ptk/reify ::fetch-apps
    ptk/UpdateEvent
    (update [_ state]
      (let [rid     (proto/next-rid)
            team-id (get-in state (state-path :team-id))
            message (cond-> {:type "apps.list" :rid rid}
                      (some? team-id) (assoc :team-id (str team-id)))]
        (-> state
            (assoc-in (state-path :rid) rid)
            (assoc-in (state-path :status) :loading)
            (request :list nil message))))))

(defn start-app
  "Run an app's dev server; `tab` is a waiting browser tab opened by the
  click (see `open-waiting-tab!`) that goes to the app once ready."
  ([project-id] (start-app project-id nil))
  ([project-id tab]
   (let [rid (proto/next-rid)]
     (ptk/reify ::start-app
       ptk/UpdateEvent
       (update [_ state]
         (-> state
             (update-in (state-path :pending) (fnil conj #{}) project-id)
             (update-in (state-path :errors) dissoc project-id)
             (request :start project-id {:type "apps.start" :rid rid :project-id project-id})))

       ptk/EffectEvent
       (effect [_ state _]
         (when (some? tab)
           (drop-waiting-tab! project-id)
           (swap! waiting-tabs assoc project-id tab))
         (when (= "not-connected" (get-in state (state-path :errors project-id :code)))
           (drop-waiting-tab! project-id)))))))

(defn stop-app
  [project-id]
  (ptk/reify ::stop-app
    ptk/UpdateEvent
    (update [_ state]
      (request state :stop project-id
               {:type "apps.stop" :rid (proto/next-rid) :project-id project-id}))

    ptk/EffectEvent
    (effect [_ _ _]
      (drop-waiting-tab! project-id))))

(defn fetch-logs
  [project-id]
  (ptk/reify ::fetch-logs
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (assoc-in (state-path :logs project-id :loading) true)
          (request :logs project-id
                   {:type "apps.logs" :rid (proto/next-rid) :project-id project-id})))))

(defn close-logs
  [project-id]
  (ptk/reify ::close-logs
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :logs) dissoc project-id))))

(defn start-phone
  "Open an Expo app on a phone. Only after the user agreed that devices
  on the local network can reach the app while the QR code is shown."
  [project-id]
  (ptk/reify ::start-phone
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (assoc-in (state-path :phone project-id) {:state "starting"})
          (request :phone project-id
                   {:type "apps.phone.start" :rid (proto/next-rid)
                    :project-id project-id :confirmed true})))))

(defn stop-phone
  [project-id]
  (ptk/reify ::stop-phone
    ptk/UpdateEvent
    (update [_ state]
      (if (client/send! {:type "apps.phone.stop" :project-id project-id})
        state
        (update-in state (state-path :phone) dissoc project-id)))))

(defn close-phone
  "Forget a finished phone session (stopped or failed)."
  [project-id]
  (ptk/reify ::close-phone
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :phone) dissoc project-id))))

(defn initialize
  "Start the daemon client for the Apps section and list the team's
  apps once connected (again after each reconnect)."
  [team-id]
  (ptk/reify ::initialize
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :apps]
                 (fn [apps]
                   (cond-> (assoc apps :team-id team-id)
                     (not= team-id (:team-id apps))
                     (dissoc :items :order :errors :logs :phone)))))

    ptk/WatchEvent
    (watch [_ state stream]
      (let [stopper (rx/filter #(or (ptk/type? ::finalize %)
                                    (ptk/type? ::initialize %))
                               stream)]
        (->> (rx/merge
              (rx/of (client/initialize))
              (if (= :connected (get-in state [:penforge :connection :status]))
                (rx/of (fetch-apps))
                (rx/empty))
              (->> stream
                   (rx/filter (ptk/type? ::client/connected))
                   (rx/map (fn [_] (fetch-apps))))
              (->> (client/messages stream)
                   (rx/filter (fn [{:keys [type]}]
                                (and (string? type)
                                     (or (str/starts-with? type "apps.")
                                         (= "error" type)))))
                   (rx/map handle-message)))
             (rx/take-until stopper))))))

(defn finalize
  "Leave the Apps section: close the daemon client (running apps keep
  running; a phone session ends with the connection)."
  []
  (ptk/reify ::finalize
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (client/finalize)))

    ptk/EffectEvent
    (effect [_ _ _]
      (doseq [project-id (keys @waiting-tabs)]
        (drop-waiting-tab! project-id)))))
