;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.adapt
  "AI actions that adapt a board to mobile or back to desktop (W14).

  The daemon workflow `adapt-responsive` copies the selected top-level
  board next to it as `<Board> / Mobile` (or `/ Desktop`), links both
  boards with shared plugin data (`penforge` `variantOf`) and reflows
  the copy. When it is done, the new board gets selected and both
  boards are shown.

  The daemon sends codes with English fallback texts (progress `code`,
  a `plan` `{code \"exists\"}` before its question, `result` `status`);
  this namespace replaces the texts of the run's chat entries with
  translated ones."
  (:require
   [app.common.files.helpers :as cfh]
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.helpers :as dsh]
   [app.main.data.workspace.selection :as dws]
   [app.main.data.workspace.zoom :as dwz]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [clojure.string :as str]
   [potok.v2.core :as ptk]))

(def workflow-name
  "adapt-responsive")

(def mobile-max-width
  "Boards up to this width count as mobile screens: they can be
  adapted to desktop, wider ones to mobile."
  600)

(defn selected-board
  "The selected shape when exactly one top-level board is selected."
  [state]
  (let [selected (dsh/get-selected-ids state)]
    (when (= 1 (count selected))
      (let [shape (dsh/lookup-shape state (first selected))]
        (when (cfh/root-frame? shape)
          shape)))))

(defn target-for
  "Target the board can be adapted to: `:mobile` for wide boards,
  `:desktop` for narrow ones."
  [board]
  (if (> (:width board) mobile-max-width)
    :mobile
    :desktop))

(defn can-adapt?
  "True when exactly one top-level board is selected and it can be
  adapted to `target`."
  [state target]
  (if-let [board (selected-board state)]
    (= target (target-for board))
    false))

(defn can-edit?
  "Whether the profile may change the open file."
  [state]
  (boolean
   (and (get-in (dsh/lookup-team state) [:permissions :can-edit])
        (not (get-in state [:workspace-global :read-only?])))))

(defn workflow-params
  [board-id target]
  {:board-id (str board-id)
   :target (name target)})

;; --- Translated texts of a run

(defn- quote-names
  [names]
  (str/join ", " (map #(str "\"" % "\"") names)))

(defn progress-text
  "Translated text of a progress `code`, or nil for unknown codes."
  [code]
  (case code
    "copy"   (tr "penforge.adapt.progress.copy")
    "read"   (tr "penforge.adapt.progress.read")
    "reflow" (tr "penforge.adapt.progress.reflow")
    "check"  (tr "penforge.adapt.progress.check")
    "fix"    (tr "penforge.adapt.progress.fix")
    nil))

(defn exists-question
  "Translated question asked when the board already has a variant for
  the target (`plan` payload `{:code \"exists\"}`)."
  [{:keys [target source-name existing]}]
  (let [names (quote-names existing)]
    (if (= "desktop" target)
      (tr "penforge.adapt.exists-desktop" source-name names)
      (tr "penforge.adapt.exists-mobile" source-name names))))

(defn option-label
  "Translated label of a question option, or nil for unknown ids."
  [id]
  (case id
    "create" (tr "penforge.adapt.option.create")
    "cancel" (tr "penforge.adapt.option.cancel")
    nil))

(defn summary-text
  "Translated run summary from the `result` payload, or nil."
  [{:keys [status name width height issue-count existing]}]
  (case status
    "created" (if (pos? (or issue-count 0))
                (tr "penforge.adapt.summary.issues" name width height issue-count)
                (tr "penforge.adapt.summary.done" name width height))
    "kept"    (tr "penforge.adapt.summary.kept" (quote-names existing))
    nil))

(defn- update-entries
  "Update the chat entries matching `pred` with `f`."
  [pred f]
  (ptk/reify ::update-entries
    ptk/UpdateEvent
    (update [_ state]
      (if (some? (get-in state [:penforge :chat :entries]))
        (update-in state [:penforge :chat :entries]
                   (fn [entries]
                     (mapv #(if (pred %) (f %) %) entries)))
        state))))

(defn- run-entry?
  [run-id entry]
  (and (= :workflow (:kind entry))
       (= run-id (:id entry))))

(defn- translate-options
  [options]
  (mapv #(if-let [label (option-label (:id %))]
           (assoc % :label label)
           %)
        options))

(defn localize
  "Event that translates the chat entry a daemon message of the run
  changed, or nil. `plan` and `result` are the last payloads of those
  kinds the run sent."
  [{:keys [message plan result]}]
  (let [{msg-type :type :keys [kind payload run-id ok]} message]
    (cond
      (and (= "workflow.event" msg-type) (= "progress" kind))
      (when-let [text (progress-text (:code payload))]
        (update-entries (partial run-entry? run-id)
                        #(assoc % :progress {:text text})))

      (and (= "workflow.event" msg-type) (= "question" kind) (= "exists" (:code plan)))
      (let [question-id (:question-id payload)
            text        (exists-question plan)]
        (update-entries #(and (= :question (:kind %)) (= question-id (:id %)))
                        #(-> %
                             (assoc :text text)
                             (update :options translate-options))))

      (and (= "workflow.done" msg-type) ok)
      (when-let [summary (summary-text result)]
        (update-entries (partial run-entry? run-id)
                        #(assoc % :summary summary)))

      :else
      nil)))

(defn- collect-run
  [acc message]
  (let [kind (when (= "workflow.event" (:type message)) (:kind message))]
    (cond-> (assoc acc :message message)
      (= "plan" kind)   (assoc :plan (:payload message))
      (= "result" kind) (assoc :result (:payload message)))))

;; --- Run

(defn show-boards
  "Select the new board and fit the view to it and its source, when
  both are on the current page."
  [{:keys [board-id source-id]}]
  (ptk/reify ::show-boards
    ptk/WatchEvent
    (watch [_ state _]
      (let [objects   (dsh/lookup-page-objects state)
            board-id  (uuid/parse* board-id)
            source-id (uuid/parse* source-id)]
        (if (contains? objects board-id)
          (rx/of (dws/select-shape board-id)
                 (dwz/fit-to-shapes (into #{board-id}
                                          (filter #(contains? objects %))
                                          [source-id])))
          (rx/empty))))))

(defn result-payload?
  "True for the `result` event of an `adapt-responsive` run that made
  a board."
  [message]
  (and (= "workflow.event" (:type message))
       (= "result" (:kind message))
       (string? (get-in message [:payload :board-id]))))

(defn adapt-board
  "Start the `adapt-responsive` workflow for a board, show its
  progress in the AI chat (translated) and show the new board when it
  is ready."
  ([board-id target]
   (adapt-board board-id target (proto/next-rid)))
  ([board-id target rid]
   (ptk/reify ::adapt-board
     ptk/WatchEvent
     (watch [_ _ stream]
       (rx/merge
        (->> (chat/workflow-messages stream rid)
             (rx/scan collect-run {})
             (rx/map localize)
             (rx/filter some?))
        (->> (chat/workflow-messages stream rid)
             (rx/filter result-payload?)
             (rx/take 1)
             (rx/map (comp show-boards :payload)))
        (rx/of (chat/open-chat)
               (chat/run-workflow workflow-name
                                  (workflow-params board-id target)
                                  {:rid rid})))))))

(defn- run-adapt
  [target]
  (fn [{:keys [state]}]
    (when-let [board (selected-board state)]
      (st/emit! (adapt-board (:id board) target)))))

(actions/register-action!
 {:id :ai/adapt-mobile
  :label #(tr "penforge.actions.adapt-mobile")
  :icon i/flex-vertical
  :order 40
  :scopes #{:context-menu :command-palette}
  :visible? #(can-adapt? % :mobile)
  :enabled? can-edit?
  :run (run-adapt :mobile)})

(actions/register-action!
 {:id :ai/adapt-desktop
  :label #(tr "penforge.actions.adapt-desktop")
  :icon i/flex-horizontal
  :order 40
  :scopes #{:context-menu :command-palette}
  :visible? #(can-adapt? % :desktop)
  :enabled? can-edit?
  :run (run-adapt :desktop)})
