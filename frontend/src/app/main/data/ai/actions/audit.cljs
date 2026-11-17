;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.audit
  "Design audit (W15): the `:ai/audit` action and the state of the
  `audit` daemon workflow runs started from this tab.

  State lives under `[:penforge :audit]`:

  - `:status` `:idle` `:running` `:done` `:error`
  - `:mode` `:audit` (check the design) or `:fix` (fix the open
    `[Audit]` comments)
  - `:rid` request id of the current run, `:run-id` once started
  - `:params` the params of the last audit (to run it again)
  - `:progress` last progress text of the daemon
  - `:result` result payload of the last audit (findings, counts,
    report); kept while a fix runs
  - `:fix-result` result payload of the last fix
  - `:summary` / `:error` from `workflow.done` (or the request error)

  `apply-run-message` is the pure reducer of the run's daemon
  messages."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def workflow-name "audit")

(def panel-type
  "Modal type of the audit results panel
  (`app.main.ui.workspace.ai.audit.panel`)."
  :penforge-audit)

(def severities
  "Severities in display order."
  ["error" "warning" "info"])

;; --- Pure helpers

(defn apply-run-message
  "Reduce a daemon message of the current run into the audit state."
  [audit {:keys [type kind payload] :as msg}]
  (case type
    "workflow.started"
    (assoc audit :run-id (:run-id msg))

    "workflow.event"
    (cond
      (= kind "progress")
      (assoc audit :progress (:summary payload))

      (and (= kind "result") (= "fix" (:mode payload)))
      (assoc audit :fix-result payload)

      (= kind "result")
      (assoc audit :result payload)

      :else
      audit)

    "workflow.done"
    (-> audit
        (assoc :status (if (:ok msg) :done :error)
               :summary (:summary msg)
               :error (:error msg))
        (dissoc :progress))

    "error"
    (-> audit
        (assoc :status :error
               :error (:message msg)
               :error-code (:code msg))
        (dissoc :progress))

    audit))

(defn group-findings
  "Findings of an audit result grouped by severity, in display order:
  a vector of `[severity findings]` with only non-empty groups."
  [findings]
  (let [by-severity (group-by :severity findings)]
    (into []
          (keep (fn [severity]
                  (when-let [group (seq (get by-severity severity))]
                    [severity (vec group)])))
          severities)))

(defn fixable-thread-ids
  "Ids of the comment threads of an audit result that \"Fix all\" sends
  to the daemon."
  [result]
  (into [] (comp (keep :thread-id) (distinct)) (:findings result)))

(defn running?
  [audit]
  (= :running (:status audit)))

(defn- start-run
  "Start a run in the audit state; the last audit result stays for a
  fix run and is dropped for a new audit."
  [audit mode rid params]
  (cond-> (-> audit
              (assoc :status :running
                     :mode mode
                     :rid rid
                     :run-id nil)
              (dissoc :summary :error :error-code :progress :fix-result))
    (= mode :audit) (-> (dissoc :result)
                        (assoc :params params))))

;; --- Events

(defn- get-audit
  [state]
  (get-in state [:penforge :audit] {:status :idle}))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- run-message
  [rid msg]
  (ptk/reify ::run-message
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (:rid (get-audit state)))
        (update-in state [:penforge :audit] apply-run-message msg)
        state))))

(defn- start
  [mode params]
  (let [rid (proto/next-rid)]
    (ptk/reify ::start
      ptk/UpdateEvent
      (update [_ state]
        (let [audit (get-audit state)]
          (cond
            (running? audit)
            state

            (not (connected? state))
            (assoc-in state [:penforge :audit]
                      (-> (start-run audit mode rid params)
                          (assoc :status :error :error-code "not-connected")))

            :else
            (assoc-in state [:penforge :audit] (start-run audit mode rid params)))))

      ptk/WatchEvent
      (watch [_ state stream]
        (let [audit (get-audit state)]
          (if (and (= rid (:rid audit)) (running? audit))
            (rx/merge
             (->> (chat/workflow-messages stream rid)
                  (rx/map (partial run-message rid)))
             (rx/of (chat/run-workflow workflow-name
                                       (assoc params :mode (name mode))
                                       {:rid rid :silent true})))
            (rx/empty)))))))

(defn start-audit
  "Audit the current page, or only `:node-ids`. `:ai` adds the Claude
  review of hierarchy and alignment."
  [{:keys [node-ids ai]}]
  (start :audit (cond-> {:ai (boolean ai)}
                  (seq node-ids) (assoc :node-ids (vec node-ids)))))

(defn rerun-audit
  "Run the last audit again, optionally changing whether the AI review
  is included."
  [ai]
  (ptk/reify ::rerun-audit
    ptk/WatchEvent
    (watch [_ state _]
      (let [params (:params (get-audit state))]
        (rx/of (start-audit (assoc params :ai ai)))))))

(defn fix-all
  "Ask the daemon to fix the open comments of the last audit."
  []
  (ptk/reify ::fix-all
    ptk/WatchEvent
    (watch [_ state _]
      (let [result     (:result (get-audit state))
            thread-ids (fixable-thread-ids result)]
        (if (seq thread-ids)
          (rx/of (start :fix {:page-id (:page-id result)
                              :thread-ids thread-ids}))
          (rx/empty))))))

(defn cancel
  "Stop the running audit or fix."
  []
  (ptk/reify ::cancel
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [run-id] :as audit} (get-audit state)]
        (if (and (running? audit) run-id)
          (rx/of (chat/cancel-workflow run-id))
          (rx/empty))))))

(defn open-panel
  []
  (modal/show panel-type {}))

;; --- Action

(actions/register-action!
 {:id :ai/audit
  :label #(tr "penforge.actions.audit")
  :icon i/status-tick
  :order 40
  :scopes #{:context-menu :main-menu :header :command-palette}
  :run (fn [{:keys [scope selected]}]
         (let [node-ids (when (and (= scope :context-menu) (seq selected))
                          (mapv str selected))]
           (st/emit! (open-panel)
                     (start-audit {:node-ids node-ids}))))})
