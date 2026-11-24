;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.instruct
  "Instruct (W41): the code-free sibling of Build for web and mobile
  projects. The daemon workflow `instruct` writes `PenforgeUI/` (PNGs,
  assets, tokens and one guide per screen) into the output folder.

  `start` asks for a folder when the project has none, plans the run
  and opens the dialog; `confirm` writes the files. Runs are silent.

  State lives under `[:penforge :instruct]`: `{:stage :idle|:planning|
  :confirm|:running|:done|:error, :rid, :run-id, :plan, :progress,
  :result, :failure-code, :error}`."
  (:require
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.modal :as modal]
   [app.main.ui.workspace.ai.build.output :as output]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(def modal-type
  "Modal id of the Instruct dialog."
  :penforge-instruct)

(def initial-state
  {:stage :idle})

(defn get-instruct
  [state]
  (get-in state [:penforge :instruct] initial-state))

(defn running?
  [instruct]
  (contains? #{:planning :running} (:stage instruct)))

;; --- Pure reducer

(defn- apply-result
  [instruct {:keys [action error] :as payload}]
  (cond
    (some? error)     (assoc instruct :failure-code error)
    (= "plan" action) (assoc instruct :plan payload)
    :else             (assoc instruct :result payload)))

(defn- finish-stage
  [{:keys [stage plan result]} ok]
  (cond
    (not ok)                                 :error
    (and (= :planning stage) (some? plan))   :confirm
    (and (= :running stage) (some? result))  :done
    :else                                    :error))

(defn apply-message
  "Reduce a daemon message of the followed run into the state."
  [instruct {:keys [type run-id kind payload ok error code message]}]
  (case type
    "workflow.started"
    (assoc instruct :run-id run-id)

    "workflow.event"
    (case kind
      ;; tool activity of Claude has no step
      "progress" (if (string? (:step payload))
                   (assoc instruct :progress (select-keys payload [:step :params :text]))
                   instruct)
      "result"   (apply-result instruct payload)
      instruct)

    "workflow.done"
    (-> instruct
        (assoc :stage (finish-stage instruct ok)
               :run-id nil)
        (dissoc :progress)
        (cond-> (not ok) (assoc :error (or error "failed"))))

    "error"
    (assoc instruct :stage :error :run-id nil :error (or code message "error"))

    instruct))

;; --- Events

(defn- receive
  [rid msg]
  (ptk/reify ::receive
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (:rid (get-instruct state)))
        (update-in state [:penforge :instruct] apply-message msg)
        state))))

(defn- stop
  []
  (ptk/reify ::stop))

(defn- connected?
  [state]
  (= :connected (get-in state [:penforge :connection :status])))

(defn- run
  [stage params]
  (let [rid (proto/next-rid)]
    (ptk/reify ::run
      ptk/UpdateEvent
      (update [_ state]
        (assoc-in state [:penforge :instruct]
                  (cond-> {:stage stage :rid rid :plan (:plan (get-instruct state))}
                    (= stage :planning) (dissoc :plan)
                    (not (connected? state)) (assoc :stage :error :error "not-connected"))))

      ptk/WatchEvent
      (watch [_ state stream]
        (if (connected? state)
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/map #(receive rid %))
                (rx/take-until (rx/filter (ptk/type? ::stop) stream)))
           (rx/of (chat/run-workflow "instruct" params {:rid rid :silent true})))
          (rx/empty))))))

(defn start-plan
  "Plan the run and open the dialog."
  []
  (ptk/reify ::start-plan
    ptk/WatchEvent
    (watch [_ _ _]
      (rx/of (stop)
             (run :planning {:action "plan"})
             (modal/show modal-type {})))))

(defn start
  "Entry point of Instruct: the folder step when the project has no
  folder, then the dialog. A run that goes on only shows the dialog."
  []
  (ptk/reify ::start
    ptk/WatchEvent
    (watch [_ state _]
      (if (running? (get-instruct state))
        (rx/of (modal/show modal-type {}))
        (rx/of (output/ensure-folder :instruct start-plan start-plan))))))

(defn confirm
  "Write the specification that was planned."
  []
  (ptk/reify ::confirm
    ptk/WatchEvent
    (watch [_ state _]
      (if (= :confirm (:stage (get-instruct state)))
        (rx/of (stop)
               (run :running {:action "run"}))
        (rx/empty)))))

(defn reopen
  "Show the dialog again (after the folder dialog was closed)."
  []
  (modal/show modal-type {}))

(defn cancel
  "Stop the run (if any), forget its state and close the dialog."
  []
  (ptk/reify ::cancel
    ptk/WatchEvent
    (watch [_ state _]
      (let [{:keys [run-id]} (get-instruct state)]
        (rx/concat
         (rx/of (stop))
         (if run-id
           (rx/of (chat/cancel-workflow run-id))
           (rx/empty))
         (rx/of (ptk/reify ::reset
                  ptk/UpdateEvent
                  (update [_ state]
                    (assoc-in state [:penforge :instruct] initial-state)))
                (modal/hide)))))))

(defn close
  "Close the dialog; a run goes on."
  []
  (modal/hide))
