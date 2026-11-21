;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.redesign-code
  "Re-Design (W38): the Build CTA of Game UI and Existing projects.

  Existing project: the `code-redesign` workflow applies the new look of
  the Penpot boards to the linked app's code, on a new
  `penforge/redesign-*` git branch, look only. Game UI: the
  `game-ui-export` workflow writes `PenforgeUI/` (a PNG of every
  screen, assets, tokens and Markdown engine guides) into the game
  folder, without touching the game's code.

  Flow: the action runs the workflow's `plan` step, the chat shows a
  confirm card (branch, what changes), confirming runs `run`; git
  questions (uncommitted changes, no repository) show in the chat
  timeline; the summary card offers to revert changes outside the look
  (`revert`).

  State lives under `[:penforge :linked :redesign]`:
  `{:status :planning|:confirm|:running|:reverting|:done|:cancelled|:failed,
  :workflow, :rid, :run-id, :progress, :plan, :result, :reverted,
  :error}`."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.linked :as linked]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]))

(def ^:private redesign-path
  [:penforge :linked :redesign])

(def running-statuses
  #{:planning :running :reverting})

;; --- Pure helpers

(defn workflow-for
  "The daemon workflow of the Re-Design of a `platform` project, or nil
  for projects that build an app instead."
  [platform]
  (case (some-> platform keyword)
    :game     "game-ui-export"
    :existing "code-redesign"
    nil))

(defn running?
  [redesign]
  (contains? running-statuses (:status redesign)))

(defn- after-revert
  "The run result once `reverted` files went back to the look before."
  [result reverted]
  (let [gone (set reverted)]
    (update result :outside-look
            (fn [items] (filterv #(not (contains? gone (:path %))) items)))))

(defn apply-redesign-message
  "The Re-Design state after a message of its current workflow run."
  [redesign {:keys [type kind payload ok error code message] :as msg}]
  (case type
    "workflow.started"
    (assoc redesign :run-id (:run-id msg))

    "workflow.event"
    (case kind
      "progress"
      (assoc redesign :progress (select-keys payload [:step :params :text]))

      "result"
      (case (:action payload)
        "plan"   (assoc redesign :status :confirm :plan payload)
        "run"    (if (:cancelled payload)
                   (assoc redesign :status :cancelled :result nil)
                   (assoc redesign :status :done :result payload))
        "revert" (-> redesign
                     (assoc :status :done)
                     (update :result after-revert (:reverted payload))
                     (update :reverted (fnil into []) (:reverted payload)))
        redesign)

      redesign)

    "workflow.done"
    (cond
      (not ok)
      (assoc redesign :status :failed :error {:message (or error (:summary msg))})

      (= :planning (:status redesign))
      (assoc redesign :status :failed :error {:message (:summary msg)})

      (contains? #{:running :reverting} (:status redesign))
      (assoc redesign :status :done)

      :else
      redesign)

    "error"
    (assoc redesign :status :failed :error {:code code :message message})

    redesign))

(defn summary-data
  "What the summary card of a finished Re-Design shows."
  [workflow result]
  (if (= workflow "game-ui-export")
    (let [screens (vec (:screens result))]
      {:kind :game
       :folder (:folder result)
       :branch (:branch result)
       :screens (count screens)
       :pngs (* 2 (count screens))
       :guides (count (filter :guide screens))
       :assets (or (:assets result) 0)})
    (let [screens (vec (:screens result))]
      {:kind :existing
       :branch (:branch result)
       :files (count (:files-changed result))
       :screens-done (count (filter #(= "done" (:status %)) screens))
       :screens-partial (count (filter #(= "partial" (:status %)) screens))
       :unmatched (vec (:unmatched result))
       :outside (vec (:outside-look result))})))

;; --- State readers

(defn get-redesign
  [state]
  (get-in state redesign-path))

(defn- linked-project?
  [state]
  (pf/linked-platform? (pf/current-platform state)))

;; --- Events

(defn- redesign-message
  [rid msg]
  (ptk/reify ::redesign-message
    ptk/UpdateEvent
    (update [_ state]
      (if (= rid (get-in state (conj redesign-path :rid)))
        (update-in state redesign-path apply-redesign-message msg)
        state))))

(defn- step-started
  [rid status]
  (ptk/reify ::step-started
    ptk/UpdateEvent
    (update [_ state]
      (update-in state redesign-path merge
                 {:status status :rid rid :run-id nil :progress nil :error nil}))))

(defn- run-step
  "Run one step (`plan`, `run`, `revert`) of the project's Re-Design
  workflow and follow its messages."
  [status params]
  (ptk/reify ::run-step
    ptk/WatchEvent
    (watch [_ state stream]
      (if-let [workflow (get-in state (conj redesign-path :workflow))]
        (let [rid (proto/next-rid)]
          (rx/merge
           (->> (chat/workflow-messages stream rid)
                (rx/map #(redesign-message rid %))
                (rx/take-until (rx/filter (ptk/type? ::linked/finalize) stream)))
           (rx/of (step-started rid status)
                  (chat/run-workflow workflow params {:rid rid :silent true}))))
        (rx/empty)))))

(defn start-redesign
  "Plan the Re-Design of the open project; the chat shows the confirm
  card once the plan is in."
  []
  (ptk/reify ::start-redesign
    ptk/UpdateEvent
    (update [_ state]
      (if-let [workflow (workflow-for (pf/current-platform state))]
        (if (running? (get-redesign state))
          state
          (assoc-in state redesign-path {:status :planning :workflow workflow}))
        state))

    ptk/WatchEvent
    (watch [_ state _]
      (let [redesign (get-redesign state)]
        (if (and (= :planning (:status redesign)) (nil? (:rid redesign)))
          (rx/of (chat/open-chat)
                 (run-step :planning {:action "plan"}))
          (rx/empty))))))

(defn confirm-redesign
  "Run the planned Re-Design; `instructions` is optional text for the AI."
  [instructions]
  (ptk/reify ::confirm-redesign
    ptk/WatchEvent
    (watch [_ state _]
      (if (= :confirm (:status (get-redesign state)))
        (rx/of (run-step :running
                         (cond-> {:action "run"}
                           (and (string? instructions) (not (str/blank? instructions)))
                           (assoc :instructions (str/trim instructions)))))
        (rx/empty)))))

(defn revert-outside
  "Put the listed files (changes outside the look) back as they were
  before the Re-Design."
  [files]
  (ptk/reify ::revert-outside
    ptk/WatchEvent
    (watch [_ state _]
      (if (and (= :done (:status (get-redesign state))) (seq files))
        (rx/of (run-step :reverting {:action "revert" :files (vec files)}))
        (rx/empty)))))

(defn dismiss-redesign
  []
  (ptk/reify ::dismiss-redesign
    ptk/UpdateEvent
    (update [_ state]
      (if (running? (get-redesign state))
        state
        (update-in state [:penforge :linked] dissoc :redesign)))))

;; --- Actions

(actions/register-action!
 {:id :ai/redesign-code
  :label #(tr "penforge.redesign.action")
  :icon i/play
  :primary true
  :order 90
  :scopes #{:island :main-menu :command-palette}
  :visible? linked-project?
  :enabled? (fn [state]
              (and (linked/read-done? state)
                   (not (running? (get-redesign state)))))
  :run (fn [_]
         (st/emit! (start-redesign)))})

(actions/register-action!
 {:id :ai/read-project
  :label #(tr "penforge.linked.read-again")
  :icon i/reload
  :order 92
  :scopes #{:main-menu :command-palette}
  :visible? linked-project?
  :enabled? (fn [state]
              (not= :running (:status (linked/get-read state))))
  :run (fn [_]
         (st/emit! (chat/open-chat)
                   (linked/start-read true)))})
