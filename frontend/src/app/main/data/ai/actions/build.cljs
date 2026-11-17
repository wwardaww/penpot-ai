;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.build
  "AI actions of the build and preview flow (W09): the primary Build
  button and the preview toggle."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.preview :as preview]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]))

(defn- building?
  [state]
  (some? (get-in state [:penforge :preview :build])))

(actions/register-action!
 {:id :ai/build
  :label #(tr "penforge.build")
  :icon i/play
  :primary true
  :order 90
  :scopes #{:header :main-menu :command-palette}
  :enabled? (fn [state] (not (building? state)))
  :run (fn [_]
         (st/emit! (preview/build)))})

(actions/register-action!
 {:id :ai/preview
  :label #(tr "penforge.preview.toggle")
  :icon i/shown
  :order 91
  :scopes #{:header :main-menu :command-palette}
  :run (fn [_]
         (st/emit! (preview/toggle-pane)))})
