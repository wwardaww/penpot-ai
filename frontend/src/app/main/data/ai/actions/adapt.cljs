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
  boards are shown."
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

(defn workflow-params
  [board-id target]
  {:board-id (str board-id)
   :target (name target)})

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
  "True for the `result` event of an `adapt-responsive` run."
  [message]
  (and (= "workflow.event" (:type message))
       (= "result" (:kind message))
       (string? (get-in message [:payload :board-id]))))

(defn adapt-board
  "Start the `adapt-responsive` workflow for a board, show its
  progress in the AI chat and show the new board when it is ready."
  ([board-id target]
   (adapt-board board-id target (proto/next-rid)))
  ([board-id target rid]
   (ptk/reify ::adapt-board
     ptk/WatchEvent
     (watch [_ _ stream]
       (rx/merge
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
  :run (run-adapt :mobile)})

(actions/register-action!
 {:id :ai/adapt-desktop
  :label #(tr "penforge.actions.adapt-desktop")
  :icon i/flex-horizontal
  :order 40
  :scopes #{:context-menu :command-palette}
  :visible? #(can-adapt? % :desktop)
  :run (run-adapt :desktop)})
