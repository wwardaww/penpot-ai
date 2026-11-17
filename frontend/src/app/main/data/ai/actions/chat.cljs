;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.chat
  "Built-in AI actions of the chat (W04)."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]))

(actions/register-action!
 {:id :ai/open-chat
  :label #(tr "penforge.actions.open-chat")
  :icon i/feedback
  :order 0
  :scopes #{:context-menu :main-menu :header :command-palette}
  :run (fn [{:keys [scope selected]}]
         (if (and (= scope :context-menu) (seq selected))
           (st/emit! (chat/attach-node selected)
                     (chat/open-chat))
           (st/emit! (chat/open-chat))))})
