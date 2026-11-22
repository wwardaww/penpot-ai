;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.apps
  "Apps on the dashboard: built apps (W33) and Re-Designed Existing
  projects (W39).

  The dashboard's Apps section talks to the Penforge daemon over the
  same client as the workspace (`app.main.data.ai.client`), without a
  `context.set`: `apps.list` lists the apps of this computer, `apps.start`
  / `apps.stop` run their dev servers, `apps.logs` reads the output and
  `apps.phone.start` / `apps.phone.stop` open an Expo app on a phone
  after the user agreed to the local network access.

  State lives under `[:penforge :apps]`:
  `{:status :loading|:loaded|:failed, :team-id, :rid, :items {id app},
  :order [id], :error {:code :message}, :errors {id {:code :reason
  :message}}, :pending #{id}, :logs {id {:loading :lines}}, :phone {id
  phone}, :rids {rid [kind id]}, :file-names {file-id name}}`, where
  `id` is the app id (`:app-id`; the project id for a built app).
  `:file-names` holds the Penpot names of the files of Re-Designed apps,
  read from the backend (`:get-project-files`), because the daemon knows
  a file's name only once a tab of it was opened. App maps are the daemon's `AppInfo`
  with kebab-case keys (`:app-id`, `:project-id`, `:redesign`,
  `:status {:state :url ...}`)."
  (:require
   [app.common.logging :as log]
   [app.common.uuid :as uuid]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.repo :as rp]
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

(defn app-id
  "The id of an app or of an `apps.*` message about one: `:app-id`, else
  the project id (a built app, or a daemon from before W39)."
  [{:keys [app-id project-id]}]
  (or app-id project-id))

(defn- app-entry?
  [app]
  (and (map? app) (string? (:project-id app)) (string? (:name app))))

(defn redesigned?
  "True for the app of a Re-Designed Existing project (W39)."
  [app]
  (map? (:redesign app)))

(defn off-branch?
  "True when the linked folder of a Re-Designed app has another branch
  checked out than the Re-Design's: the app then runs that branch."
  [app]
  (let [{:keys [branch current-branch]} (:redesign app)]
    (and (string? branch) (not= branch current-branch))))

(defn app-title
  "The title of an app's card. A Re-Designed app is named after its
  Penpot file: the name the backend gave (`file-names`, file id -> name)
  wins over the daemon's, which falls back to the folder name while the
  daemon has not seen the file open. The daemon's ` (<folder>)` suffix,
  added when several apps share a name, is kept."
  [{:keys [name file-id redesign]} file-names]
  (let [file-name (when (and (map? redesign) (string? file-id))
                    (get file-names file-id))]
    (if (and (string? file-name) (not (str/blank? file-name)))
      (let [{:keys [app-dir root]} redesign
            folder (if (str/blank? app-dir)
                     (last (str/split (str root) #"[\\/]+"))
                     app-dir)
            suffix (str " (" folder ")")]
        (if (and (string? name) (not (str/blank? folder)) (str/ends-with? name suffix))
          (str file-name suffix)
          file-name))
      name)))

(defn missing-name-projects
  "Projects with Re-Designed apps whose file name is not known yet."
  [apps file-names]
  (into #{}
        (comp (filter #(and (redesigned? %)
                            (string? (:file-id %))
                            (not (contains? file-names (:file-id %)))))
              (map :project-id))
        apps))

(defn- state-path
  [& ks]
  (into [:penforge :apps] ks))

(defn- remember-rid
  [state rid kind id]
  (assoc-in state (state-path :rids rid) [kind id]))

(defn- apply-error
  "Store the `error` reply of a request where its card shows it."
  [state {:keys [rid] :as msg}]
  (if-let [[kind id] (get-in state (state-path :rids rid))]
    (let [error (select-keys msg [:code :reason :message])
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
    state))

(defn apply-message
  "Apply a daemon message to the state; returns the state unchanged for
  messages that are not about the apps."
  [state {:keys [type rid] :as msg}]
  (let [id (app-id msg)]
    (case type
      "apps.list"
      (if (= rid (get-in state (state-path :rid)))
        (let [apps (filterv app-entry? (:apps msg))]
          (update-in state [:penforge :apps] merge
                     {:status :loaded
                      :error nil
                      :items (into {} (map (juxt app-id identity)) apps)
                      :order (mapv app-id apps)}))
        state)

      "apps.status"
      (cond-> state
        (contains? (get-in state (state-path :items)) id)
        (assoc-in (state-path :items id :status)
                  (select-keys msg [:state :url :reason :message :exposure]))

        :always
        (update-in (state-path :pending) disj id)

        (contains? #{"ready" "starting"} (:state msg))
        (update-in (state-path :errors) dissoc id))

      "apps.logs"
      (assoc-in state (state-path :logs id)
                {:loading false
                 :lines (filterv #(string? (:text %)) (:lines msg))})

      "apps.phone"
      (assoc-in state (state-path :phone id)
                (select-keys msg [:state :url :host :port :qr :expires-at :code :message]))

      "error"
      (apply-error state msg)

      state)))

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
  [id state url]
  (when-let [^js tab (get @waiting-tabs id)]
    (cond
      (and (= state "ready") (safe-app-url? url))
      (do (swap! waiting-tabs dissoc id)
          (set! (.-location tab) url))

      (contains? #{"failed" "stopped"} state)
      (do (swap! waiting-tabs dissoc id)
          (.close tab)))))

(defn- drop-waiting-tab!
  [id]
  (when-let [^js tab (get @waiting-tabs id)]
    (swap! waiting-tabs dissoc id)
    (.close tab)))

;; --- Events

(declare fetch-apps)

(defn- files-named
  [names]
  (ptk/reify ::files-named
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :file-names) merge names))))

(defn- fetch-file-names
  "Read the file names of the given Penpot projects from the backend
  (one light query per project); failures keep the daemon's names."
  [project-ids]
  (ptk/reify ::fetch-file-names
    ptk/WatchEvent
    (watch [_ _ _]
      (->> (rx/from (keep uuid/parse* project-ids))
           (rx/merge-map
            (fn [project-id]
              (->> (rp/cmd! :get-project-files {:project-id project-id})
                   (rx/map (fn [files]
                             (files-named
                              (into {}
                                    (keep (fn [{:keys [id name]}]
                                            (when (and (some? id) (string? name))
                                              [(str id) name])))
                                    files))))
                   (rx/catch (fn [cause]
                               (log/warn :hint "unable to read the file names" :cause cause)
                               (rx/empty))))))))))

(defn- handle-message
  [msg]
  (ptk/reify ::handle-message
    ptk/UpdateEvent
    (update [_ state]
      (apply-message state msg))

    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [items file-names]} (get-in state [:penforge :apps])
            projects (when (= "apps.list" (:type msg))
                       (missing-name-projects (vals items) file-names))]
        (if (seq projects)
          (rx/of (fetch-file-names projects))
          (rx/empty))))

    ptk/EffectEvent
    (effect [_ state _]
      (case (:type msg)
        "apps.status"
        (when-not (= "restarting" (:reason msg))
          (settle-waiting-tab! (app-id msg) (:state msg) (:url msg)))
        "error"
        ;; a refused start closes the tab it opened
        (doseq [id (keys @waiting-tabs)]
          (when (get-in state (state-path :errors id))
            (drop-waiting-tab! id)))
        nil))))

(defn- app-ref
  "The ids a request names an app by: its project and its app id."
  [state id]
  {:project-id (or (get-in state (state-path :items id :project-id)) id)
   :app-id id})

(defn- request
  "Send a request; on a closed connection mark it failed right away."
  [state kind id message]
  (if (client/send! message)
    (remember-rid state (:rid message) kind id)
    (case kind
      :list (update-in state [:penforge :apps] merge
                       {:status :failed :error {:code "not-connected"}})
      (-> state
          (assoc-in (state-path :errors id) {:code "not-connected"})
          (update-in (state-path :pending) disj id)))))

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
  "Run an app's dev server; `id` is the app id. `tab` is a waiting
  browser tab opened by the click (see `open-waiting-tab!`) that goes to
  the app once ready."
  ([id] (start-app id nil))
  ([id tab]
   (let [rid (proto/next-rid)]
     (ptk/reify ::start-app
       ptk/UpdateEvent
       (update [_ state]
         (-> state
             (update-in (state-path :pending) (fnil conj #{}) id)
             (update-in (state-path :errors) dissoc id)
             (request :start id (merge {:type "apps.start" :rid rid} (app-ref state id)))))

       ptk/EffectEvent
       (effect [_ state _]
         (when (some? tab)
           (drop-waiting-tab! id)
           (swap! waiting-tabs assoc id tab))
         (when (= "not-connected" (get-in state (state-path :errors id :code)))
           (drop-waiting-tab! id)))))))

(defn stop-app
  [id]
  (ptk/reify ::stop-app
    ptk/UpdateEvent
    (update [_ state]
      (request state :stop id
               (merge {:type "apps.stop" :rid (proto/next-rid)} (app-ref state id))))

    ptk/EffectEvent
    (effect [_ _ _]
      (drop-waiting-tab! id))))

(defn fetch-logs
  [id]
  (ptk/reify ::fetch-logs
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (assoc-in (state-path :logs id :loading) true)
          (request :logs id
                   (merge {:type "apps.logs" :rid (proto/next-rid)} (app-ref state id)))))))

(defn close-logs
  [id]
  (ptk/reify ::close-logs
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :logs) dissoc id))))

(defn start-phone
  "Open an Expo app on a phone. Only after the user agreed that devices
  on the local network can reach the app while the QR code is shown."
  [id]
  (ptk/reify ::start-phone
    ptk/UpdateEvent
    (update [_ state]
      (-> state
          (assoc-in (state-path :phone id) {:state "starting"})
          (request :phone id
                   (merge {:type "apps.phone.start" :rid (proto/next-rid) :confirmed true}
                          (app-ref state id)))))))

(defn stop-phone
  [id]
  (ptk/reify ::stop-phone
    ptk/UpdateEvent
    (update [_ state]
      (if (client/send! (merge {:type "apps.phone.stop"} (app-ref state id)))
        state
        (update-in state (state-path :phone) dissoc id)))))

(defn close-phone
  "Forget a finished phone session (stopped or failed)."
  [id]
  (ptk/reify ::close-phone
    ptk/UpdateEvent
    (update [_ state]
      (update-in state (state-path :phone) dissoc id))))

(defn initialize
  "Start the daemon client for the Apps section and list the team's
  apps once connected (again after each reconnect)."
  [team-id]
  (ptk/reify ::initialize
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :apps]
                 (fn [apps]
                   ;; file names are read again on each visit (renames)
                   (cond-> (-> apps (assoc :team-id team-id) (dissoc :file-names))
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
      (doseq [id (keys @waiting-tabs)]
        (drop-waiting-tab! id)))))
