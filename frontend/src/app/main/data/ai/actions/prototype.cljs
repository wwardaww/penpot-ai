;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.prototype
  "Wire prototype (W27).

  Registers the `:ai/wire-prototype` action (context menu, main menu,
  command palette). It opens the wire prototype dialog for the current
  page, or only for the selected screens when two or more top-level
  boards are selected. The dialog runs the daemon workflow
  `wire-prototype`, lists the proposed links to confirm and applies
  the confirmed ones in one undo step."
  (:require
   [app.common.files.helpers :as cfh]
   [app.main.data.ai.actions :as actions]
   [app.main.data.helpers :as dsh]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   ;; registers the `:penforge-wire-prototype` modal
   [app.main.ui.workspace.ai.prototype.dialog]
   [app.util.i18n :refer [tr]]))

(defn can-edit?
  "True when the open file can be changed: edit permission and not in
  read-only mode."
  [state]
  (and (true? (get-in state [:permissions :can-edit]))
       (not (get-in state [:workspace-global :read-only?]))))

(defn selected-screen-ids
  "Ids (strings) of the selected top-level boards when two or more are
  selected; otherwise nil (the whole page is wired)."
  [objects selected]
  (let [ids (into []
                  (comp (map #(get objects %))
                        (filter cfh/root-frame?)
                        (map (comp str :id)))
                  selected)]
    (when (>= (count ids) 2)
      ids)))

(defn dialog-props
  "Props of the wire prototype dialog for the workspace state and the
  selected shape ids."
  [state selected]
  (let [objects (dsh/lookup-page-objects state)]
    {:page-id (some-> (:current-page-id state) str)
     :board-ids (selected-screen-ids objects selected)}))

(actions/register-action!
 {:id :ai/wire-prototype
  :label #(tr "penforge.actions.wire-prototype")
  :icon i/play
  :order 45
  :scopes #{:context-menu :main-menu :command-palette}
  :visible? can-edit?
  :enabled? can-edit?
  :run (fn [{:keys [state selected]}]
         (st/emit! (modal/show :penforge-wire-prototype
                               (dialog-props state (or selected (dsh/get-selected-ids state))))))})
