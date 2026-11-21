;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.redesign
  "Design system binding (W30): a project uses one of the team's design
  systems (W29 shared libraries) and the AI follows it strictly.

  - Pick: the picker (AI menu, command palette, new-project dialog)
    runs `design-system-bind {action \"link\"}` in the chat; the daemon
    links the library, makes it the tokens source, records it in
    `.penforge/project.json` and asks once whether to apply it to an
    existing design.
  - Re-design later: while `redesignPending`, the AI menu shows
    \"Apply design system\" (`:ai/design-system-apply`, workflow
    `design-system-redesign`). Not W38's code \"Re-Design\"
    (`:redesign-code`).
  - Check: after AI writes the daemon fixes drift and explains it
    (`chat.tool` / `log` code `design-system-fixed`); what the system
    lacks comes as ONE list (`design-system-missing`) with \"Add to
    design system\" / \"Don't add\".
  - Add to design system: the daemon asks to open the design system
    file in a new tab (`open-design-system`); that tab finds the task
    (`design-system-missing {action \"pending\"}`) and builds it.

  State `[:penforge :design-system-binding]` `{:file-id :loaded
  :binding :file-linked :is-system :missing :fixed :running :progress
  :error :task :task-result}`."
  (:require
   [app.common.data :as d]
   [app.common.json :as json]
   [app.common.logging :as log]
   [app.config :as cf]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.design-system :as ds]
   [app.main.data.modal :as modal]
   [app.main.repo :as rp]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.globals :as globals]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(log/set-level! :info)

;; --- Constants

(def bind-workflow "design-system-bind")
(def check-workflow "design-system-check")
(def redesign-workflow "design-system-redesign")
(def missing-workflow "design-system-missing")

(def check-tool
  "Tool name of the daemon's design system check lines in `chat.tool`."
  "penforge_design_system_check")

(def fixed-code "design-system-fixed")
(def missing-code "design-system-missing")
(def open-event "open-design-system")

(def picker-key :penforge-design-system-picker)

(def state-path [:penforge :design-system-binding])

(def choice-prefix
  "localStorage key prefix of the design system chosen for a new
  project (its first file links it)."
  "penforge.design-system.project.")

(def close-delay-ms
  "Time the design system tab shows its done notice before it closes."
  4000)

;; --- Pure helpers

(defn current
  "Binding state of the open file, or nil."
  [state]
  (let [s (get-in state state-path)]
    (when (and (some? s) (= (:file-id s) (:current-file-id state)))
      s)))

(defn binding-of
  [state]
  (:binding (current state)))

(defn bound?
  "Whether the project of the open file uses a design system."
  [state]
  (some? (:file-id (binding-of state))))

(defn redesign-pending?
  [state]
  (true? (:redesign-pending (binding-of state))))

(defn- param
  [params k]
  (let [v (get params k)]
    (if (nil? v) "" (str v))))

(defn fix-text
  "Translated explanation of one fix `{:code :params}` (W30 codes)."
  [{:keys [code params]}]
  (let [layer (param params :layer)
        from  (param params :from)
        to    (param params :to)
        nm    (param params :name)]
    (case code
      "color"      (tr "penforge.design-system-binding.fix.color" layer from nm to)
      "typography" (tr "penforge.design-system-binding.fix.typography" layer from nm to)
      "radius"     (tr "penforge.design-system-binding.fix.radius" layer from nm to)
      "spacing"    (tr "penforge.design-system-binding.fix.spacing" layer from nm to)
      "component"  (tr "penforge.design-system-binding.fix.component" layer nm)
      "swap"       (tr "penforge.design-system-binding.fix.swap" layer from nm)
      nil)))

(defn finding-text
  "Translated line for drift the check could not fix."
  [{:keys [code params]}]
  (let [layer (param params :layer)
        from  (param params :from)
        to    (param params :to)
        nm    (param params :name)]
    (case code
      "off-color"         (tr "penforge.design-system-binding.finding.off-color" layer from nm to)
      "off-typography"    (tr "penforge.design-system-binding.finding.off-typography" layer from nm)
      "off-radius"        (tr "penforge.design-system-binding.finding.off-radius" layer from nm to)
      "off-spacing"       (tr "penforge.design-system-binding.finding.off-spacing" layer from nm to)
      "off-shadow"        (tr "penforge.design-system-binding.finding.off-shadow" layer)
      "local-component"   (tr "penforge.design-system-binding.finding.local-component" layer nm)
      "foreign-component" (tr "penforge.design-system-binding.finding.local-component" layer nm)
      nil)))

(defn failed-text
  "Translated text of a `failed` code."
  [code]
  (case code
    "not-linked"          (tr "penforge.design-system-binding.error.not-linked")
    "not-allowed"         (tr "penforge.design-system-binding.error.not-allowed")
    "link-failed"         (tr "penforge.design-system-binding.error.link-failed")
    "no-items"            (tr "penforge.design-system-binding.error.no-items")
    "timeout"             (tr "penforge.design-system-binding.error.timeout")
    "library-not-updated" (tr "penforge.design-system-binding.error.library-not-updated")
    "wrong-file"          (tr "penforge.design-system-binding.error.wrong-file")
    "task-missing"        (tr "penforge.design-system-binding.error.task-missing")
    "cancelled"           (tr "penforge.design-system-binding.error.cancelled")
    (tr "penforge.design-system-binding.error.internal")))

(defn fixed-of
  "The fix report of a daemon payload (`design-system-fixed` params or a
  check result) with the English summary next to it."
  [payload summary]
  (when (map? payload)
    {:fixes (vec (:fixes payload))
     :findings (vec (:findings payload))
     :linked (or (:linked payload) 0)
     :total (or (:total payload) (count (:fixes payload)))
     :summary summary}))

(defn fixed-lines
  "Translated lines of a fix report: explained fixes first, then what is
  left. Unknown codes are skipped."
  [{:keys [fixes findings]}]
  (into (vec (keep fix-text fixes))
        (keep finding-text findings)))

(defn open-items
  "Missing items still waiting for a decision."
  [s]
  (vec (:missing s)))

(defn- check-message?
  "A daemon message of the design system check: a `chat.tool` line of
  the check tool, or a `log` event of a design workflow."
  [{:keys [type tool-name kind payload code]}]
  (or (and (= "chat.tool" type)
           (= check-tool tool-name)
           (contains? #{fixed-code missing-code} code))
      (and (= "workflow.event" type)
           (= "log" kind)
           (contains? #{fixed-code missing-code} (:code payload)))))

(defn fold-check
  "Folds a check message into the binding state."
  [s {:keys [type code params summary payload]}]
  (let [[code params text] (if (= "chat.tool" type)
                             [code params summary]
                             [(:code payload) (:params payload) (:text payload)])]
    (cond
      (= fixed-code code)
      (assoc s :fixed (fixed-of params text))

      (= missing-code code)
      (assoc s :missing (vec (:items params)))

      :else s)))

(defn- without-items
  [items ids]
  (let [ids (set ids)]
    (vec (remove #(contains? ids (:id %)) items))))

(defn fold-result
  "Folds a run's `result` payload into the binding state, by job."
  [s job result]
  (case job
    :status   (-> s
                  (assoc :loaded true
                         :binding (:binding result)
                         :file-linked (:file-linked result)
                         :is-system (true? (:is-system result))
                         :missing (vec (:missing result))))
    :link     (cond-> (assoc s :binding (:binding result))
                (some? (:redesign-result result))
                (assoc :fixed (fixed-of (:redesign-result result)
                                        (get-in result [:redesign-result :summary]))))
    :redesign (-> s
                  (assoc-in [:binding :redesign-pending] false)
                  (assoc :fixed (fixed-of result (:summary result))))
    :check    (assoc s
                     :fixed (fixed-of result (:summary result))
                     :missing (vec (:missing result)))
    :keep     (update s :missing without-items (:kept result))
    :add      (update s :missing without-items (map :item-id (:created result)))
    :pending  (assoc s :task (when (:task-id result) result))
    :build    (assoc s :task-result result)
    s))

(defn next-state
  "Folds one message of a followed run (`job`) into the binding state."
  [s job {:keys [type kind payload] :as message}]
  (case type
    "workflow.started"
    (-> s (assoc :running job) (dissoc :error :progress))

    "workflow.event"
    (cond
      (= "result" kind)   (fold-result s job payload)
      (= "failed" kind)   (assoc s :error (or (:code payload) "internal"))
      (= "progress" kind) (assoc s :progress (:text payload))
      (check-message? message) (fold-check s message)
      :else s)

    "workflow.done"
    (cond-> (dissoc s :running :progress)
      (and (false? (:ok message)) (nil? (:error s)))
      (assoc :error (if (= "cancelled" (:error message)) "cancelled" "internal")))

    "error"
    (-> s (dissoc :running :progress) (assoc :error (or (:code message) "internal")))

    s))

(defn choice
  "A design system choice `{:file-id :name :project-id :version}` from a
  design system file of the dashboard list."
  [{:keys [id name project-id revn]}]
  (d/without-nils {:file-id (some-> id str)
                   :name name
                   :project-id (some-> project-id str)
                   :version revn}))

;; --- Project choice (new-project dialog → first file)

(defn- local-storage
  []
  (try
    (unchecked-get globals/global "localStorage")
    (catch :default _ nil)))

(defn project-choice
  "The design system chosen for a new project, or nil."
  [project-id]
  (try
    (when-let [storage (local-storage)]
      (when-let [raw (.getItem ^js storage (str choice-prefix project-id))]
        (let [value (json/decode raw)]
          (when (and (map? value) (some? (:file-id value)))
            value))))
    (catch :default _ nil)))

(defn- store-project-choice!
  [project-id value]
  (try
    (when-let [storage (local-storage)]
      (if (some? value)
        (.setItem ^js storage (str choice-prefix project-id) (json/encode value))
        (.removeItem ^js storage (str choice-prefix project-id))))
    (catch :default cause
      (log/warn :hint "unable to store the design system choice" :cause cause))))

(defn remember-choice-for-new-project
  "Keeps `ds-choice` for the project the create-project dialog is about
  to create: waits for its `project-created` event (30 s at most). The
  project's first file links it when the AI session starts."
  [ds-choice]
  (ptk/reify ::remember-choice-for-new-project
    ptk/WatchEvent
    (watch [_ _ stream]
      (if (some? (:file-id ds-choice))
        (->> stream
             (rx/filter (ptk/type? :app.main.data.dashboard/project-created))
             (rx/take 1)
             (rx/take-until (rx/timer 30000))
             (rx/tap (fn [event]
                       (when-let [project-id (:id (deref event))]
                         (store-project-choice! project-id ds-choice))))
             (rx/ignore))
        (rx/empty)))))

;; --- Runs

(defn- folded
  [file-id job message]
  (ptk/reify ::folded
    ptk/UpdateEvent
    (update [_ state]
      (if (= file-id (:current-file-id state))
        (update-in state state-path
                   (fn [s]
                     (next-state (if (= file-id (:file-id s)) s {:file-id file-id})
                                 job message)))
        state))))

(declare open-system-tab)

(defn- follow
  "Starts workflow `wf` and folds its messages into the binding state.
  `on-result` (fn of the result payload → observable of events) runs
  after the result."
  [wf params {:keys [job silent on-result]}]
  (let [rid (str (random-uuid))]
    (ptk/reify ::follow
      ptk/WatchEvent
      (watch [_ state stream]
        (let [file-id (:current-file-id state)]
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/mapcat
                 (fn [{:keys [type kind payload] :as message}]
                   (rx/concat
                    (rx/of (folded file-id job message))
                    (cond
                      (and (= "workflow.event" type) (= open-event kind))
                      (rx/of (open-system-tab payload))

                      (and (= "workflow.event" type) (= "result" kind) (fn? on-result))
                      (on-result payload)

                      :else
                      (rx/empty)))))
                (rx/catch (fn [cause]
                            (log/warn :hint "design system binding run failed" :cause cause)
                            (rx/of (folded file-id job {:type "error" :code "internal"})))))
           (rx/of (chat/run-workflow wf params {:rid rid :silent silent}))))))))

(defn open-system-tab
  "Opens the design system file in a new tab (the daemon's `add` run
  waits for that tab)."
  [{:keys [file-id]}]
  (ptk/reify ::open-system-tab
    ptk/WatchEvent
    (watch [_ state _]
      (if (some? file-id)
        (rx/of (rt/nav :workspace
                       {:team-id (:current-team-id state) :file-id file-id}
                       {::rt/new-window true}))
        (rx/empty)))))

(defn link-design-system
  "Links a design system `{:file-id :name :project-id :version}` to the
  project (question and progress in the chat). Options: `:silent`,
  `:redesign` (\"now\" | \"later\")."
  ([ds-choice] (link-design-system ds-choice nil))
  ([{:keys [file-id name project-id version]} {:keys [silent redesign]}]
   (ptk/reify ::link-design-system
     ptk/WatchEvent
     (watch [_ _ _]
       (rx/concat
        (if silent (rx/empty) (rx/of (modal/hide) (chat/open-chat)))
        (rx/of (follow bind-workflow
                       (d/without-nils {:action "link"
                                        :file-id (str file-id)
                                        :name name
                                        :project-id (str project-id)
                                        :version (some-> version str)
                                        :redesign redesign})
                       {:job :link :silent silent})))))))

(defn- after-status
  "After the status: link the project's chosen design system to its first
  file, or link a new file of a project that already uses one."
  [state result]
  (let [project-id (:current-project-id state)
        stored     (project-choice project-id)
        bound-ds   (:binding result)]
    (cond
      (or (true? (:is-system result)) (not (ds/can-edit? state)))
      (rx/empty)

      (and (nil? bound-ds) (some? stored))
      (do (store-project-choice! project-id nil)
          (rx/of (link-design-system stored {:silent true :redesign "later"})))

      (and (some? bound-ds) (false? (:file-linked result)))
      (rx/of (link-design-system bound-ds {:silent true :redesign "later"}))

      :else
      (rx/empty))))

(defn fetch-status
  "Reads the project's design system (silent)."
  []
  (ptk/reify ::fetch-status
    ptk/WatchEvent
    (watch [_ state _]
      (rx/of (follow bind-workflow {:action "status"}
                     {:job :status :silent true
                      :on-result (fn [result] (after-status state result))})))))

(defn apply-design-system
  "Restyles the whole file with the project's design system (W30
  \"Apply design system\")."
  []
  (ptk/reify ::apply-design-system
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (chat/open-chat)
             (follow redesign-workflow {} {:job :redesign})))))

(defn check-design-system
  "Checks the open page against the design system and fixes the drift."
  []
  (ptk/reify ::check-design-system
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (chat/open-chat)
             (follow check-workflow {:mode "fix"} {:job :check})))))

(defn keep-missing
  "\"Don't add\": the items stay the project's own."
  [ids]
  (follow missing-workflow {:action "keep" :ids (vec ids)} {:job :keep :silent true}))

(defn add-missing
  "\"Add to design system\": the design system tab makes them, then the
  project uses them (progress in the chat)."
  [ids]
  (ptk/reify ::add-missing
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (chat/open-chat)
             (follow missing-workflow {:action "add" :ids (vec ids)} {:job :add})))))

(defn- close-tab-later
  []
  (ptk/reify ::close-tab-later
    ptk/EffectEvent
    (effect [_ _ _]
      ;; only a tab opened by the project tab may close itself
      (when (some? (unchecked-get globals/global "opener"))
        (js/setTimeout #(.close ^js globals/global) close-delay-ms)))))

(defn build-task
  "Design system tab: makes the items the project tab asked for."
  [task-id]
  (ptk/reify ::build-task
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (chat/open-chat)
             (follow missing-workflow {:action "build" :task-id task-id}
                     {:job :build
                      :on-result (fn [_] (rx/of (close-tab-later)))})))))

(defn check-pending-task
  "Design system tab: picks up the task the project tab left (silent)."
  []
  (follow missing-workflow {:action "pending"}
          {:job :pending :silent true
           :on-result (fn [result]
                        (if-let [task-id (:task-id result)]
                          (rx/of (build-task task-id))
                          (rx/empty)))}))

(defn dismiss-fixed
  []
  (ptk/reify ::dismiss-fixed
    ptk/UpdateEvent
    (update [_ state]
      (if (current state)
        (update-in state state-path dissoc :fixed)
        state))))

;; --- Watcher (one per AI session)

(defn- check-folded
  [message]
  (ptk/reify ::check-folded
    ptk/UpdateEvent
    (update [_ state]
      (let [file-id (:current-file-id state)]
        (update-in state state-path
                   (fn [s]
                     (fold-check (if (= file-id (:file-id s)) s {:file-id file-id})
                                 message)))))))

(defn- on-connected
  []
  (ptk/reify ::on-connected
    ptk/WatchEvent
    (watch [_ state _]
      (cond
        (or (not (contains? cf/flags :ai)) (nil? (:current-file-id state)))
        (rx/empty)

        (ds/design-system-file? state)
        (if (ds/can-edit? state) (rx/of (check-pending-task)) (rx/empty))

        :else
        (rx/of (fetch-status))))))

(defn watch-binding
  "Follows the AI session: reads the status once connected, folds the
  check's messages of chat turns and design workflows."
  []
  (ptk/reify ::watch-binding
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? ::client/finalize) stream)
                     (rx/filter (ptk/type? ::client/initialize) stream))]
        (->> (rx/merge
              (->> stream
                   (rx/filter (ptk/type? ::client/connected))
                   (rx/map (fn [_] (on-connected))))
              (->> (client/messages stream)
                   (rx/filter check-message?)
                   (rx/map check-folded)))
             (rx/take-until stopper))))))

(defonce watcher-subscription
  (->> st/stream
       (rx/filter (ptk/type? ::client/initialize))
       (rx/subs! (fn [_] (st/emit! (watch-binding))))))

;; --- Actions

(defn pick-visible?
  "\"Use a design system\": editors of a normal file."
  [state]
  (and (contains? cf/flags :ai)
       (some? (:current-file-id state))
       (ds/can-edit? state)
       (not (ds/design-system-file? state))
       (not (chat/busy? (get-in state [:penforge :chat])))))

(defn open-picker
  []
  (modal/show picker-key {}))

(actions/register-action!
 {:id :ai/design-system-pick
  :label #(tr "penforge.design-system-binding.action.pick")
  :icon i/library
  :order 41
  :scopes #{:header :main-menu :command-palette}
  :visible? pick-visible?
  :run (fn [_] (st/emit! (open-picker)))})

(actions/register-action!
 {:id :ai/design-system-apply
  :label #(tr "penforge.design-system-binding.action.apply")
  :icon i/library
  :order 42
  :scopes #{:header :main-menu :command-palette}
  :visible? (fn [state]
              (and (pick-visible? state)
                   (redesign-pending? state)))
  :run (fn [_] (st/emit! (apply-design-system)))})

(actions/register-action!
 {:id :ai/design-system-check
  :label #(tr "penforge.design-system-binding.action.check")
  :icon i/tick
  :order 43
  :scopes #{:main-menu :command-palette}
  :visible? (fn [state]
              (and (pick-visible? state)
                   (bound? state)))
  :run (fn [_] (st/emit! (check-design-system)))})

(defn team-file
  "The design system file of a dashboard list by id, or nil."
  [files file-id]
  (d/seek #(= (str (:id %)) (str file-id)) files))

(defn current-name
  "Name of the open project's design system, or nil."
  [state]
  (some-> (binding-of state) :name str/trim not-empty))

(defn fetch-team-design-systems
  "Answers an observable with the team's design system files (with
  their library summary), newest first."
  [team-id]
  (if (some? team-id)
    (->> (rp/cmd! :get-projects {:team-id team-id})
         (rx/mapcat ds/fetch-design-systems))
    (rx/of [])))

(defn selectable?
  "A design system can be picked once it is a shared library."
  [file]
  (true? (:is-shared file)))
