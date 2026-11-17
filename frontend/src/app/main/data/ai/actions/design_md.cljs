;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.design-md
  "AI action of the DESIGN.md design system panel (W22)."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   ;; registers the `:penforge-design-md` modal
   [app.main.ui.workspace.ai.design-md.panel]
   [app.util.i18n :refer [tr]]))

(actions/register-action!
 {:id :ai/design-md
  :label #(tr "penforge.actions.design-md")
  :icon i/tokens
  :order 60
  :scopes #{:main-menu :command-palette}
  :run (fn [_]
         (st/emit! (modal/show :penforge-design-md {})))})
