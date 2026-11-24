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

  Change requests (W34): once an app is built, the Build button turns
  into Update. `start-update` opens the dialog on the list of design
  changes since the last build (`build-changes`), and
  `confirm-update` runs `build-run {update}`, which writes a change
  request and builds from it. Both the plan and the change list take
  instructions for the AI. A watcher keeps `[:penforge :build-changes]`
  (badge count) current while the AI session of the file runs.

  Output folder (W41): the first build of a project asks for a folder
  before it plans (`output/ensure-folder`); an update asks only when the
  folder is gone.

  State lives under `[:penforge :build]`:

  - `:stage` `:idle` `:planning` `:plan` `:changes` `:review`
    `:building` `:done` `:error`
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
  - `:error` technical error (`workflow.done` error or request error)
  - `:question` open question of the run `{:question-id :text :options}`
    (an instruction that conflicts with the design, W34)"
  (:require
   [app.common.data :as d]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.preview :as preview]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.build.output :as output]
   [beicon.v2.core :as rx]
   [beicon.v2.operators :as rxo]
   [cuerdas.core :as str]
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
  (contains? #{:planning :changes :building} (:stage build)))

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

    "question"
    (assoc build :question (select-keys payload [:question-id :text :options]))

    build))

(defn- finish-stage
  [build ok]
  (cond
    (not ok) :error
    (= "build-plan" (:workflow build)) (if (:plan build) :plan :error)
    (= "build-changes" (:workflow build)) (if (:result build) :review :error)
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
        (dissoc :question)
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

(declare changes-loaded check-changes)

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
      (let [build (get-build state)
            done? (and (= rid (:rid build)) (= "workflow.done" (:type msg)))]
        (cond
          (and done? (= :done (:stage build)))
          (rx/of (built (:current-project-id state) (:result build))
                 (check-changes))

          ;; the dialog's change list also refreshes the Update badge
          (and done? (= :review (:stage build)))
          (rx/of (changes-loaded (:result build)))

          :else
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
                      (contains? params :update) (assoc :update true)
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

(defn start-plan
  "Open the build dialog and plan a build."
  []
  (ptk/reify ::start-plan
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (stop)
             (plan)
             (modal/show modal-type {})))))

(defn start
  "Open the build dialog and plan a build, unless a run is going on
  (then only the dialog opens). A project without an output folder
  asks for one first (W41). Entry point of the Build button."
  []
  (ptk/reify ::start
    ptk/WatchEvent
    (watch [_ state _]
      (if (running? (get-build state))
        (rx/of (modal/show modal-type {}))
        (rx/of (output/ensure-folder :build start-plan start-plan))))))

(defn reopen
  "Show the build dialog again (after the folder dialog was closed)."
  []
  (modal/show modal-type {}))

(defn folder-changed
  "Go on after the folder was changed from the dialog: a first plan does
  not depend on the folder and stays; anything else starts over."
  []
  (ptk/reify ::folder-changed
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [stage plan]} (get-build state)]
        (if (and (= :plan stage) (= "full" (:mode plan)))
          (rx/of (reopen))
          (rx/of (start-plan)))))))

(defn confirm
  "Build the shown plan. `overrides` are the developer's edits:
  `{:notes :stack-name :routes {\"<board-id>\" \"/route\"}}`;
  `instructions` the instructions for the AI `{:text :keep :kept}`
  (W34). A plan with nothing to do plans a full rebuild instead."
  ([] (confirm nil nil))
  ([overrides] (confirm overrides nil))
  ([overrides instructions]
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
                         (seq overrides) (assoc :overrides overrides)
                         (seq instructions) (assoc :instructions instructions))))))))))

(declare list-changes)

(defn retry
  "Start over after an error: plan again, or list the changes again
  when the failed run was an update."
  []
  (ptk/reify ::retry
    ptk/WatchEvent
    (watch [_ state _]
      (let [build (get-build state)]
        (if (or (= "build-changes" (:workflow build))
                (:update build))
          (rx/of (stop) (list-changes))
          (rx/of (start)))))))

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
  "Close the dialog and show the generated app in the preview pane
  (W09): opens the pane, starts the dev server (or reloads a running
  one); the pane shows progress and any failure."
  []
  (ptk/reify ::open-preview
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (modal/hide)
             (preview/show-app)))))

;; --- Change requests (W34)

(def changes-debounce-ms
  "Quiet time after the last saved design change before the Update
  badge is refreshed: the daemon reads the whole design, so edits in a
  row make one check."
  8000)

(defn get-changes
  "Design changes since the last build, as last listed by
  `build-changes`: `{:status :has-build :count :token-only :changes
  :last-build :kept-instructions}`. `:status` is `:idle` `:checking`
  `:ready` or `:error`."
  [state]
  (get-in state [:penforge :build-changes] {:status :idle}))

(defn get-cta
  "Mode of the Build button for a `get-changes` value: `:build` (no app
  built yet, or not known yet), `:update` (changes since the last
  build, or a count not known) or `:up-to-date`."
  [changes]
  (let [{:keys [has-build status]} changes
        n (:count changes)]
    (cond
      (not (true? has-build)) :build
      (and (number? n) (pos? n)) :update
      (and (= status :ready) (number? n)) :up-to-date
      :else :update)))

(defn get-change-count
  "Number of listed changes (0 when not known)."
  [changes]
  (let [n (:count changes)]
    (if (number? n) n 0)))

(defn apply-changes-result
  "Store the `result` payload of `build-changes`. A busy answer (a build
  runs) keeps the last list: the build's end checks again."
  [changes result]
  (if (:busy result)
    (assoc changes :status :ready)
    (assoc changes
           :status :ready
           :has-build (true? (:has-build result))
           :count (:count result)
           :token-only (true? (:token-only result))
           :changes (:changes result)
           :last-build (:last-build result)
           :kept-instructions (or (:kept-instructions result) ""))))

(defn apply-changes-message
  "Reduce a daemon message of a background `build-changes` run."
  [changes {:keys [type kind payload ok]}]
  (cond
    (and (= "workflow.event" type) (= "result" kind))
    (apply-changes-result changes payload)

    (or (and (= "workflow.done" type) (not ok))
        (= "error" type))
    (assoc changes :status :error)

    :else
    changes))

(defn- update-changes
  [state f & args]
  (apply update-in state [:penforge :build-changes] (fnil f {:status :idle}) args))

(defn changes-loaded
  "Store a `build-changes` result listed by the dialog."
  [result]
  (ptk/reify ::changes-loaded
    ptk/UpdateEvent
    (update [_ state]
      (update-changes state apply-changes-result result))))

(defn- can-check?
  [state]
  (and (connected? state) (not (running? (get-build state)))))

(defn check-changes
  "List the design changes since the last build in the background (a
  silent, read-only `build-changes` run) for the Update badge. Skipped
  without a connection and while a build runs (its end checks again)."
  []
  (let [rid (proto/next-rid)]
    (ptk/reify ::check-changes
      ptk/UpdateEvent
      (update [_ state]
        (if (can-check? state)
          (update-changes state assoc :status :checking)
          state))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (can-check? state)
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/map (fn [msg]
                          (ptk/reify ::changes-message
                            ptk/UpdateEvent
                            (update [_ state]
                              (update-changes state apply-changes-message msg))))))
           (rx/of (chat/run-workflow "build-changes" {}
                                     {:rid rid :silent true :read-only true})))
          (rx/empty))))))

(defn- design-revision
  "What the Update badge follows: the connection and the saved revision
  of the open file."
  [state]
  [(connected? state)
   (:revn (dsh/lookup-file state))])

(defn watch-changes
  "Keep the Update badge current until the AI session of the file
  stops: a check once connected, then after saved design changes
  (debounced)."
  []
  (ptk/reify ::watch-changes
    ptk/WatchEvent
    (watch [_ _ stream]
      (let [stopper (rx/merge
                     (rx/filter (ptk/type? ::client/finalize) stream)
                     (rx/filter (ptk/type? ::client/initialize) stream)
                     (rx/filter (ptk/type? ::watch-changes) stream))]
        (->> (rx/from-atom st/state {:emit-current-value? true})
             (rx/map design-revision)
             (rx/pipe (rxo/distinct-contiguous))
             (rx/filter first)
             (rx/debounce changes-debounce-ms)
             (rx/map (fn [_] (check-changes)))
             (rx/take-until stopper))))))

;; The AI session starts with `client/initialize` (once per open file);
;; the watcher follows it.
(defonce changes-watcher-subscription
  (->> st/stream
       (rx/filter (ptk/type? ::client/initialize))
       (rx/subs! (fn [_] (st/emit! (watch-changes))))))

(defn list-changes
  "List the changes since the last build in the dialog (`build-changes`)."
  []
  (run :changes "build-changes" {}))

(defn- start-review
  []
  (ptk/reify ::start-review
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (stop)
             (list-changes)
             (modal/show modal-type {})))))

(defn start-update
  "Open the dialog on the changes since the last build: the Update
  button. A running build only opens the dialog. When the app's folder
  is gone, it asks for a folder and plans a build there (W41)."
  []
  (ptk/reify ::start-update
    ptk/WatchEvent
    (watch [_ state _]
      (if (running? (get-build state))
        (rx/of (modal/show modal-type {}))
        (rx/of (output/ensure-folder :build start-review start-plan))))))

(defn get-instructions
  "Instructions for the AI as `build-run` takes them, from the dialog's
  fields: the new text, the keep checkbox and the kept instructions
  (sent only when edited). Nil when there is nothing to send."
  [{:keys [text keep kept kept-original]}]
  (let [text (some-> text str/trim not-empty)]
    (not-empty
     (cond-> {}
       (some? text) (assoc :text text)
       (and (some? text) keep) (assoc :keep true)
       (and (string? kept) (not= (str/trim kept) (str/trim (or kept-original ""))))
       (assoc :kept (str/trim kept))))))

(defn confirm-update
  "Run the update shown in the change list: `build-run {update}` writes
  a change request and builds from it. `instructions` as returned by
  `get-instructions`."
  [instructions]
  (ptk/reify ::confirm-update
    ptk/WatchEvent
    (watch [_ state _]
      (if (= :review (:stage (get-build state)))
        (rx/of (stop)
               (run :building "build-run" {:update (or instructions {})}))
        (rx/empty)))))

(defn answer
  "Answer the open question of the followed run (an instruction that
  conflicts with the design)."
  [option-id]
  (ptk/reify ::answer
    ptk/UpdateEvent
    (update [_ state]
      (update-in state [:penforge :build] dissoc :question))

    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [run-id question]} (get-build state)]
        (if (and run-id question)
          (rx/of (chat/answer-question run-id (:question-id question) option-id))
          (rx/empty))))))
