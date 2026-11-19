;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.ai.actions.design-system
  "Design system mode (W29): hides the app actions in design system
  files, opens the chat with the start card when such a file opens,
  and offers \"Publish as library\" in the AI menus."
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.chat :as chat]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.design-system :as ds]
   [app.main.store :as st]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

(actions/register-guard! ::design-system-mode ds/action-visible?)

;; The AI session starts with `client/initialize` (once per open file);
;; design-system mode follows it.
(defonce mode-subscription
  (->> st/stream
       (rx/filter (ptk/type? ::client/initialize))
       (rx/subs! (fn [_] (st/emit! (ds/start-mode))))))

(defn- design-system-editor?
  [state]
  (and (ds/design-system-file? state)
       (ds/can-edit? state)))

(actions/register-action!
 {:id :ai/design-system
  :label #(tr "penforge.design-systems.action.open")
  :icon i/library
  :order 1
  :scopes #{:main-menu :command-palette}
  :visible? design-system-editor?
  :run (fn [_]
         (st/emit! (chat/open-chat)))})

(actions/register-action!
 {:id :ai/design-system-publish
  :label #(tr "penforge.design-systems.action.publish")
  :icon i/library
  :order 2
  :scopes #{:main-menu :command-palette}
  :visible? #(and (design-system-editor? %) (not (ds/shared? %)))
  :run (fn [_]
         (st/emit! (ds/publish)))})
