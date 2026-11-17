;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.events
  "State and events of the Build pipeline (W08).

  `start` opens the build dialog and runs the daemon workflow
  `build-plan`; `confirm` runs `build-run` with the plan id (and the
  developer's edits); a finished build emits `::built`, the hook for
  the preview (W09). Runs are silent: they never show in the chat.

  State lives under `[:penforge :build]`:

  - `:stage` `:idle` `:planning` `:plan` `:building` `:done` `:error`
  - `:workflow` the running or last workflow (`build-plan`/`build-run`)
  - `:rid` request id of the run the state follows; `:run-id` its id
    while it runs
  - `:plan` payload of the `plan` event (kept while building)
  - `:steps` progress steps `{:id :step :status :name :update :detail
    :label}`, in order; the UI translates by `:step` (`:label` is the
    daemon's English fallback)
  - `:activity` latest tool activity line of Claude
  - `:logs` technical log lines (developers only)
  - `:result` payload of the `result` event
  - `:failure-code` code of a `failed` event (translated by the UI) and
    `:failure` its message (English; technical for developers)
  - `:error` technical error (`workflow.done` error or request error)"
  (:require
   [app.common.data :as d]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def modal-type
  "Modal id of the build dialog."
  :penforge-build)

(def initial-state
  {:stage :idle
   :steps []
   :logs []})

(defn get-build
  [state]
  (get-in state [:penforge :build] initial-state))

(defn running?
  [build]
  (contains? #{:planning :building} (:stage build)))

;; --- Pure reducer

(defn- upsert-step
  "Add a progress step, or update the step with the same id."
  [steps {:keys [id] :as step}]
  (let [index (first (keep-indexed (fn [i s] (when (= id (:id s)) i)) steps))]
    (if index
      (assoc steps index step)
      (conj steps step))))

(defn- apply-event
  [build {:keys [kind payload]}]
  (case kind
    "plan"
    (assoc build :plan payload)

    "progress"
    (if (string? (:step payload))
      (-> build
          (update :steps upsert-step (d/without-nils
                                      {:id (or (:id payload) (:step payload))
                                       :step (:step payload)
                                       :name (:name payload)
                                       :update (:update payload)
                                       :detail (:detail payload)
                                       :label (:label payload)
                                       :status (keyword (:status payload))}))
          (assoc :activity nil))
      (assoc build :activity (:summary payload)))

    "log"
    (update build :logs conj (:text payload))

    "failed"
    (assoc build
           :failure-code (:code payload)
           :failure (:message payload))

    "result"
    (assoc build :result payload)

    build))

(defn- finish-stage
  [build ok]
  (cond
    (not ok) :error
    (= "build-plan" (:workflow build)) (if (:plan build) :plan :error)
    :else :done))

(defn apply-message
  "Reduce a daemon message of the followed run into the build state."
  [build {:keys [type run-id ok error code message] :as msg}]
  (case type
    "workflow.started"
    (assoc build :run-id run-id)

    "workflow.event"
    (apply-event build msg)

    "workflow.done"
    (-> build
        (assoc :stage (finish-stage build ok)
               :run-id nil
               :activity nil)
        (cond-> (not ok) (assoc :error (or error "failed"))))

    "error"
    (assoc build
           :stage :error
           :run-id nil
           :error (or code message "error"))

    build))

;; --- Events

(defn built
  "Emitted when `build-run` finished well; `result` is its `result`
  payload. W09 starts the preview from it."
  [project-id result]
  (ptk/data-event ::built {:project-id project-id :result result}))

(defn- stop
  "Stop following the current run."
  []
  (ptk/reify ::stop))

(defn- receive
  [rid msg]
  (ptk/reify ::receive
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (:rid (get-build state)))
        (update-in state [:penforge :build] apply-message msg)
        state))

    ptk/WatchEvent
    (watch [_ state _]
      (let [build (get-build state)]
        (if (and (= rid (:rid build))
                 (= "workflow.done" (:type msg))
                 (= :done (:stage build)))
          (rx/of (built (:current-project-id state) (:result build)))
          (rx/empty))))))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- run
  "Run `workflow` and follow its messages into the build state."
  [stage workflow params]
  (let [rid (proto/next-rid)]
    (ptk/reify ::run
      ptk/UpdateEvent
      (update [_ state]
        (let [build (get-build state)]
          (assoc-in state [:penforge :build]
                    (cond-> (assoc initial-state
                                   :stage stage
                                   :workflow workflow
                                   :rid rid)
                      (= stage :building) (assoc :plan (:plan build))
                      (not (connected? state)) (assoc :stage :error
                                                      :error "not-connected")))))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (connected? state)
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/map #(receive rid %))
                (rx/take-until (rx/filter (ptk/type? ::stop) stream)))
           (rx/of (chat/run-workflow workflow params {:rid rid :silent true})))
          (rx/empty))))))

(defn plan
  "Plan a build (`build-plan`). `mode` \"full\" plans from scratch.
  The dialog confirms the plan itself, so the workflow must not ask."
  ([] (plan nil))
  ([mode]
   (run :planning "build-plan" (cond-> {:ask false}
                                 (some? mode) (assoc :mode mode)))))

(defn start
  "Open the build dialog and plan a build, unless a run is going on
  (then only the dialog opens). Entry point of the Build button."
  []
  (ptk/reify ::start
    ptk/WatchEvent
    (watch [_ state _]
      (rx/concat
       (if (running? (get-build state))
         (rx/empty)
         (rx/of (stop) (plan)))
       (rx/of (modal/show modal-type {}))))))

(defn confirm
  "Build the shown plan. `overrides` are the developer's edits:
  `{:notes :stack-name :routes {\"<board-id>\" \"/route\"}}`. A plan
  with nothing to do plans a full rebuild instead."
  ([] (confirm nil))
  ([overrides]
   (ptk/reify ::confirm
     ptk/WatchEvent
     (watch [_ state _]
       (let [{:keys [stage] :as build} (get-build state)
             plan-payload (:plan build)]
         (cond
           (not= :plan stage)
           (rx/empty)

           (= "none" (:mode plan-payload))
           (rx/of (stop) (plan "full"))

           :else
           (rx/of (stop)
                  (run :building "build-run"
                       (cond-> {:plan-id (:plan-id plan-payload)}
                         (seq overrides) (assoc :overrides overrides))))))))))

(defn retry
  "Start over after an error: plan again."
  []
  (ptk/reify ::retry
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (stop) (plan)))))

(defn cancel
  "Stop the running workflow (if any), forget the build state and close
  the dialog."
  []
  (ptk/reify ::cancel
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [run-id]} (get-build state)]
        (rx/concat
         (rx/of (stop))
         (if run-id
           (rx/of (chat/cancel-workflow run-id))
           (rx/empty))
         (rx/of (ptk/reify ::reset
                  ptk/UpdateEvent
                  (update [_ state]
                    (assoc-in state [:penforge :build] initial-state)))
                (modal/hide)))))))

(defn close
  "Close the dialog; a running build goes on."
  []
  (modal/hide))

(defn open-preview
  "Ask the daemon to start the preview of the generated app (W09
  answers with `preview.ready`) and close the dialog."
  []
  (ptk/reify ::open-preview
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (modal/hide)))

    ptk/EffectEvent
    (effect [_ state _]
      (when-let [project-id (:current-project-id state)]
        (client/send! (proto/preview-start project-id))))))
