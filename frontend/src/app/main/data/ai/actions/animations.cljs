;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.animations
  "Animation settings (W32).

  Registers the `:ai/animation-settings` action (main menu, command
  palette): it opens the dialog with the project setting \"AI may add
  animations\"."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   ;; registers the `:penforge-animation-settings` modal
   [app.main.ui.workspace.ai.animations.settings]
   [app.util.i18n :refer [tr]]))

(defn can-edit?
  "True when the open file can be changed: edit permission and not in
  read-only mode."
  [state]
  (and (true? (get-in state [:permissions :can-edit]))
       (not (get-in state [:workspace-global :read-only?]))))

(actions/register-action!
 {:id :ai/animation-settings
  :label #(tr "penforge.actions.animation-settings")
  :icon i/play
  :order 46
  :scopes #{:main-menu :command-palette}
  :visible? can-edit?
  :enabled? can-edit?
  :run (fn [_]
         (st/emit! (modal/show :penforge-animation-settings {})))})
