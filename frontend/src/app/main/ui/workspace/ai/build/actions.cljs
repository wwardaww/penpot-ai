;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.build.actions
  "AI actions of the Build pipeline (W08). Loading this namespace also
  registers the build dialog modal. The header Build button
  (`:ai/build`) belongs to W09; `app.main.ui.workspace.ai.build.events/start`
  is the entry point it can use to open this dialog."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.ai.build.dialog]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.util.i18n :refer [tr]]))

(actions/register-action!
 {:id :ai/build-app
  :label #(tr "penforge.actions.build-app")
  :icon i/code
  :order 50
  :scopes #{:main-menu :command-palette}
  :run (fn [_] (st/emit! (build/start)))})
