;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.detached
  "AI actions of the detached chat window (W10). Requiring the window
  namespace registers how the chat renders into the detached window."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.detached :as detached]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.workspace.ai.detached.window]
   [app.util.i18n :refer [tr]]))

(actions/register-action!
 {:id :ai/detach-chat
  :label #(tr "penforge.actions.detach-chat")
  :icon i/external-link
  :order 1
  :scopes #{:main-menu :command-palette}
  :visible? (complement detached/detached?)
  :run (fn [_] (st/emit! (detached/detach)))})

(actions/register-action!
 {:id :ai/dock-chat
  :label #(tr "penforge.actions.dock-chat")
  :icon i/arrow-left
  :order 1
  :scopes #{:main-menu :command-palette}
  :visible? detached/detached?
  :run (fn [_] (st/emit! (detached/dock)))})
