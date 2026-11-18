;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.publish
  "Share and publish the generated app (W20): ZIP download, GitHub,
  Vercel, Netlify and the phone preview, plus the provider accounts.
  The daemon does the work through the `publish` workflow
  (architecture §7); the tokens live only in the daemon. A token the
  user types is written once to the daemon socket with `connect`; it
  is never put in the app state, in browser storage or in a URL.

  State lives under `[:penforge :publish]`:

  - `:status` `:idle` `:loading` `:loaded` `:error`
  - `:accounts` provider keyword -> `{:login :saved-at}`
  - `:app` `{:exists :phone}`
  - `:published` where the project went (`.penforge/publish.json`)
  - `:tab` `:share` or `:accounts`
  - `:target` section the panel opened on (`:github`, ...)
  - `:busy` actions running, action keyword -> run id (or `:pending`)
  - `:progress` action -> last progress payload
  - `:results` action -> last result payload
  - `:errors` action -> `{:code :params :message :detail}`
  - `:plans` target -> where a push or deployment would go (daemon
    `plan` result: repository name and visibility, site name, new or
    existing), shown in the confirmation
  - `:phone` `{:state :url :qr :expires-at}` of the running phone
    preview"
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.data.notifications :as ntf]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def state-path [:penforge :publish])

(def modal-type :penforge-share)

(def providers [:github :vercel :netlify])

(def targets #{:zip :github :vercel :netlify :phone})

(def empty-state
  {:status :idle
   :accounts {}
   :app {}
   :published {}
   :tab :share
   :target nil
   :busy {}
   :progress {}
   :results {}
   :errors {}
   :plans {}
   :phone nil})

;; --- Pure helpers

(defn- ->keyword
  [value]
  (cond
    (keyword? value) value
    (string? value)  (keyword value)
    :else            nil))

(defn apply-status
  "Store a `status` result."
  [state {:keys [accounts app published requested]}]
  (let [target (->keyword requested)]
    (cond-> (assoc state
                   :status :loaded
                   :accounts (into {}
                                   (map (fn [{:keys [provider login saved-at]}]
                                          [(keyword provider) {:login login :saved-at saved-at}]))
                                   accounts)
                   :app (or app {})
                   :published (or published {}))
      (contains? targets target)
      (assoc :target target :tab :share))))

(defn connected-account
  "Account of a provider, or nil when it is not connected."
  [publish provider]
  (get-in publish [:accounts provider]))

(defn busy?
  "Whether an action (or any action, without one) is running."
  ([publish] (boolean (seq (:busy publish))))
  ([publish action] (contains? (:busy publish) action)))

(defn apply-run-message
  "Reduce one daemon message of the run of `action`."
  [state action {:keys [type run-id kind payload ok error code message]}]
  (case type
    "workflow.started"
    (-> state
        (assoc-in [:busy action] run-id)
        (update :errors dissoc action)
        (update :results dissoc action))

    "workflow.event"
    (case kind
      "progress" (assoc-in state [:progress action] payload)
      "failed"   (assoc-in state [:errors action] payload)
      "phone"    (assoc state :phone payload)
      "result"   (cond-> (assoc-in state [:results action] payload)
                   (= action :status)
                   (apply-status payload)

                   (= "plan" (:action payload))
                   (assoc-in [:plans (keyword (:target payload))] payload)

                   (and (= action :connect) (:account payload))
                   (assoc-in [:accounts (keyword (get-in payload [:account :provider]))]
                             (select-keys (:account payload) [:login :saved-at]))

                   (= action :disconnect)
                   (update :accounts dissoc (keyword (:provider payload))))
      state)

    "workflow.done"
    (cond-> (-> state
                (update :busy dissoc action)
                (update :progress dissoc action))
      (= action :phone)
      (assoc :phone nil)

      (= action :status)
      (update :status #(if ok % :error))

      (and (not ok)
           (not= error "cancelled")
           (nil? (get-in state [:errors action])))
      (assoc-in [:errors action] {:code "internal" :message error}))

    "error"
    (-> state
        (update :busy dissoc action)
        (update :progress dissoc action)
        (cond-> (= action :status) (assoc :status :error))
        (assoc-in [:errors action] {:code (or code "internal") :message message}))

    state))

(defn error-text
  "Plain-language text of a publish failure (the daemon sends codes)."
  [{:keys [code params message]}]
  (let [provider (or (:provider params) "")]
    (case code
      "no-app"           (tr "penforge.publish.error.no-app")
      "not-connected"    (tr "penforge.publish.error.not-connected")
      "token-invalid"    (tr "penforge.publish.error.token-invalid" provider)
      "token-scope"      (tr "penforge.publish.error.token-scope" provider)
      "token-format"     (tr "penforge.publish.error.token-format" provider)
      "name-taken"       (tr "penforge.publish.error.name-taken" (or (:name params) ""))
      "repo-diverged"    (tr "penforge.publish.error.repo-diverged")
      "build-failed"     (tr "penforge.publish.error.build-failed")
      "no-output"        (tr "penforge.publish.error.no-output")
      "too-large"        (tr "penforge.publish.error.too-large")
      "deploy-failed"    (tr "penforge.publish.error.deploy-failed" provider)
      "timeout"          (tr "penforge.publish.error.timeout" provider)
      "network"          (tr "penforge.publish.error.network" provider)
      "rate-limited"     (tr "penforge.publish.error.rate-limited" provider)
      "no-phone-preview" (tr "penforge.publish.error.no-phone-preview")
      "no-network"       (tr "penforge.publish.error.no-network")
      "preview-failed"   (tr "penforge.publish.error.preview-failed")
      "busy"             (tr "penforge.publish.error.busy")
      "not-connected-daemon" (tr "penforge.publish.error.daemon")
      (if (str/blank? message)
        (tr "penforge.publish.error.unknown")
        (tr "penforge.publish.error.other" message)))))

;; --- Events

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- update-publish
  [state f & args]
  (apply update-in state state-path (fnil f empty-state) args))

(declare fetch-status)

(defn- run-message
  "Store a message of the run of `action` and do what its result asks."
  [action msg]
  (ptk/reify ::run-message
    ptk/UpdateEvent
    (update [_ state]
      (update-publish state apply-run-message action msg))

    ptk/WatchEvent
    (watch [_ _ _]
      (let [{:keys [type kind payload ok]} msg]
        (cond
          (and (= type "workflow.event") (= kind "result") (= action :zip) (:url payload))
          (do
            (dom/trigger-download-uri (:filename payload) "application/zip" (:url payload))
            (rx/empty))

          (and (= type "workflow.event") (= kind "result") (= action :connect))
          (rx/of (ntf/success (tr "penforge.publish.accounts.connected"
                                  (get-in payload [:account :login]))))

          (and (= type "workflow.done") ok (contains? #{:github :vercel :netlify} action))
          (rx/of (fetch-status))

          :else
          (rx/empty))))))

(defn- follow-run
  "Messages of the run started with `rid`, as `run-message` events,
  until it ends or the connection drops (then the run is marked
  ended)."
  [stream action rid]
  (let [closed (rx/filter (ptk/type? ::client/socket-closed) stream)]
    (rx/merge
     (->> (chat/workflow-messages stream rid)
          (rx/take-until closed)
          (rx/map #(run-message action %)))
     (->> closed
          (rx/take 1)
          (rx/take-until (->> (chat/workflow-messages stream rid)
                              (rx/filter #(contains? #{"workflow.done" "error"} (:type %)))))
          (rx/map (fn [_]
                    (run-message action {:type "error" :code "not-connected-daemon"})))))))

(defn- run-publish
  "Start `publish` with `params` for `action`, outside the chat."
  [action params]
  (ptk/reify ::run-publish
    ptk/UpdateEvent
    (update [_ state]
      (if (connected? state)
        (update-publish state #(-> %
                                   (assoc-in [:busy action] :pending)
                                   (update :errors dissoc action)))
        (update-publish state assoc-in [:errors action] {:code "not-connected-daemon"})))

    ptk/WatchEvent
    (watch [_ state stream]
      (if (connected? state)
        (let [rid (proto/next-rid)]
          (rx/merge
           (rx/of (chat/run-workflow "publish" (update params :action #(or % (name action)))
                                     {:rid rid :silent true}))
           (follow-run stream action rid)))
        (rx/empty)))))

(defn fetch-status
  "Load the accounts and where the project was published."
  []
  (ptk/reify ::fetch-status
    ptk/UpdateEvent
    (update [_ state]
      (update-publish state assoc :status :loading))

    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (run-publish :status {})))))

(defn connect-account
  "Send a token to the daemon, which checks and keeps it. The token is
  written straight to the socket (no chat run entry, no state)."
  [provider token]
  (let [rid (proto/next-rid)]
    (ptk/reify ::connect-account
      ptk/UpdateEvent
      (update [_ state]
        (update-publish state #(-> %
                                   (assoc-in [:busy :connect] :pending)
                                   (assoc :connecting provider)
                                   (update :errors dissoc :connect))))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (and (connected? state)
                 (client/send! (proto/workflow-run {:rid rid
                                                    :name "publish"
                                                    :params {:action "connect"
                                                             :provider (name provider)
                                                             :token token}})))
          (follow-run stream :connect rid)
          (rx/of (run-message :connect {:type "error" :code "not-connected-daemon"})))))))

(defn disconnect-account
  [provider]
  (run-publish :disconnect {:provider (name provider)}))

(defn download-zip
  []
  (run-publish :zip {}))

(defn plan-action
  "State key of the plan request of `target`."
  [target]
  (keyword (str "plan-" (name target))))

(defn plan-target
  "Ask the daemon where a push (`:github`, with `:name` and `:private?`)
  or a deployment (`:vercel`, `:netlify`) would go, so the confirmation
  can name the repository or site and its visibility."
  ([target] (plan-target target nil))
  ([target {:keys [name private?]}]
   (let [action (plan-action target)]
     (ptk/reify ::plan-target
       ptk/UpdateEvent
       (update [_ state]
         (update-publish state update :plans dissoc target))

       ptk/WatchEvent
       (watch [_ _ _]
         (rx/of (run-publish action
                             (cond-> {:action "plan" :target (clojure.core/name target)}
                               (not (str/blank? name)) (assoc :name (str/trim name))
                               (some? private?)        (assoc :private (boolean private?))))))))))

(defn publish-github
  "Push the app to the repository of the confirmed plan; `public-ok?`
  when the user also agreed that the repository is public."
  [{:keys [repo private public-ok?]}]
  (run-publish :github {:confirmed true
                        :name repo
                        :private (boolean private)
                        :confirmed-public (boolean public-ok?)}))

(defn deploy
  "Put the app online with `provider` (`:vercel` or `:netlify`) on the
  site the user confirmed (`site-name` from the plan)."
  [provider site-name]
  (run-publish provider {:confirmed true :site-name site-name}))

(defn start-phone
  "Open the app on a phone (LAN access until stopped); the user agreed
  in the panel."
  []
  (run-publish :phone {:confirmed true}))

(defn phone-live?
  "Whether a phone preview runs (the app is open to the local network)."
  [state]
  (contains? (get-in state (conj state-path :busy)) :phone))

(defn stop-phone
  []
  (ptk/reify ::stop-phone
    ptk/WatchEvent
    (watch [_ state _]
      (let [run-id (get-in state (conj state-path :busy :phone))]
        (if (string? run-id)
          (rx/of (chat/cancel-workflow run-id))
          (rx/empty))))))

(defn select-tab
  [tab]
  (ptk/reify ::select-tab
    ptk/UpdateEvent
    (update [_ state]
      (update-publish state assoc :tab tab))))

(defn clear-error
  [action]
  (ptk/reify ::clear-error
    ptk/UpdateEvent
    (update [_ state]
      (update-publish state update :errors dissoc action))))

(defn open-share
  "Show the Share panel, on `target` when given."
  ([] (open-share nil))
  ([target]
   (ptk/reify ::open-share
     ptk/UpdateEvent
     (update [_ state]
       (update-publish state assoc
                       :tab (if (= target :accounts) :accounts :share)
                       :target (when (contains? targets target) target)))

     ptk/WatchEvent
     (watch [_ state _]
       (rx/concat
        (if (= modal-type (get-in state [::modal/modal :type]))
          (rx/empty)
          (rx/of (modal/show modal-type {})))
        (rx/of (fetch-status)))))))

(defn close-share
  "Hide the panel; a running phone preview ends with it."
  []
  (ptk/reify ::close-share
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (stop-phone) (modal/hide)))))

;; --- From the AI chat

(defn open-publish-call?
  "Whether a daemon message is the AI chat calling the tool that opens
  the Share panel."
  [{:keys [type tool-name status]}]
  (and (= type "chat.tool")
       (string? tool-name)
       (str/ends-with? tool-name "penforge_open_publish")
       (= status "done")))

(defonce chat-watcher
  ;; The chat's `penforge_open_publish` tool opens the panel; the target
  ;; the chat asked for comes with the panel's status request.
  (->> (client/messages st/stream)
       (rx/filter open-publish-call?)
       (rx/subs! (fn [_] (st/emit! (open-share))))))

;; --- Actions

(actions/register-action!
 {:id :ai/share
  :label #(tr "penforge.actions.share")
  :icon i/share
  :order 70
  :scopes #{:header :main-menu :command-palette}
  :enabled? connected?
  :run (fn [_] (st/emit! (open-share)))})

(actions/register-action!
 {:id :ai/phone-live
  :label #(tr "penforge.actions.phone-live")
  :icon i/status-alert
  :order 1
  :primary true
  :scopes #{:header}
  :visible? phone-live?
  :run (fn [_] (st/emit! (stop-phone)))})

(actions/register-action!
 {:id :ai/accounts
  :label #(tr "penforge.actions.accounts")
  :icon i/user
  :order 71
  :scopes #{:main-menu :command-palette}
  :enabled? connected?
  :run (fn [_] (st/emit! (open-share :accounts)))})
