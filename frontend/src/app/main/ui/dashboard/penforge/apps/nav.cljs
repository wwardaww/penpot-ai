;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.apps.nav
  "\"Apps\" entry of the dashboard sidebar (W33). Rendered by the sidebar
  with its own classes, so it looks like the entries next to it."
  (:require
   [app.main.data.penforge :as pf]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.components.link :refer [link*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

(def section
  "Route name of the Apps section."
  :dashboard-apps)

(mf/defc apps-nav-item*
  "Sidebar entry; renders nothing without the `:ai` flag. `classes` are
  the sidebar's `{:item :current :link :title}` class names."
  [{:keys [current-section team-id classes]}]
  (let [current? (= current-section section)

        go-apps
        (mf/use-fn
         (mf/deps team-id)
         (fn []
           (st/emit! (rt/nav section {:team-id team-id}))))

        go-apps-with-key
        (mf/use-fn
         (mf/deps go-apps)
         (fn []
           (go-apps)
           (dom/focus! (dom/get-element "dashboard-apps-title"))))]

    (when (pf/enabled?)
      [:li {:class (str (:item classes) (when current? (str " " (:current classes))))}
       [:> link* {:action go-apps
                  :class (:link classes)
                  :keyboard-action go-apps-with-key
                  :data-testid "penforge-apps-link"}
        [:span {:class (:title classes)} (tr "penforge.apps.title")]]])))
