;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.apps.page
  "Apps section of the dashboard (W33): the apps built on this computer
  as cards. Needs the Penforge daemon; without it, or without pairing,
  the section shows how to start or pair it instead of the grid."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.apps :as apps]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.apps.card :refer [app-card*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.workspace.ai.chat.banner :refer [connection-banner*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:apps
  (l/derived #(get-in % [:penforge :apps]) st/state))

(def ^:private ref:connection
  (l/derived #(get-in % [:penforge :connection]) st/state))

(def ^:private ref:developer
  (l/derived #(= :developer (pf/current-persona %)) st/state))

(mf/defc apps-grid*
  "Cards of the listed apps, or the empty and loading notices."
  [{:keys [apps-state developer connected]}]
  (let [{:keys [status items order pending errors logs phone error]} apps-state

        on-retry
        (mf/use-fn #(st/emit! (apps/fetch-apps)))]
    (cond
      (and (= status :failed) (empty? order))
      [:div {:class (stl/css :notice)}
       [:> text* {:as "p" :typography t/body-medium}
        (if (= "not-configured" (:code error))
          (tr "penforge.apps.error.unavailable")
          (tr "penforge.apps.error.list"))]
       [:> button* {:variant "secondary" :icon i/reload :on-click on-retry}
        (tr "penforge.chat.status.retry")]]

      (and (not= status :loaded) (empty? order))
      [:div {:class (stl/css :notice)}
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
        (tr "penforge.apps.loading")]]

      (empty? order)
      [:div {:class (stl/css :notice)}
       [:> heading* {:level 2 :typography t/headline-small}
        (tr "penforge.apps.empty.title")]
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :muted)}
        (tr "penforge.apps.empty.hint")]]

      :else
      [:div {:class (stl/css :grid) :data-testid "penforge-apps-grid"}
       (for [project-id order]
         [:> app-card* {:key project-id
                        :app (get items project-id)
                        :developer developer
                        :connected connected
                        :pending (contains? pending project-id)
                        :error (get errors project-id)
                        :logs (get logs project-id)
                        :phone (get phone project-id)}])])))

(mf/defc apps-page*
  [{:keys [team]}]
  (let [team-id    (:id team)
        apps-state (mf/deref ref:apps)
        connection (mf/deref ref:connection)
        developer  (mf/deref ref:developer)
        connected  (= :connected (:status connection))

        on-refresh
        (mf/use-fn #(st/emit! (apps/fetch-apps)))]

    (mf/with-effect [team-id]
      (dom/set-html-title (tr "penforge.apps.title"))
      (st/emit! (apps/initialize (some-> team-id str)))
      (fn [] (st/emit! (apps/finalize))))

    [:*
     [:header {:class (stl/css :dashboard-header) :data-testid "dashboard-header"}
      [:div#dashboard-apps-title {:class (stl/css :dashboard-title)}
       [:> heading* {:level 1
                     :typography t/title-large
                     :class (stl/css :dashboard-title-text)}
        (tr "penforge.apps.title")]]
      (when connected
        [:> button* {:variant "ghost" :icon i/reload :on-click on-refresh}
         (tr "penforge.apps.refresh")])]

     [:section {:class (stl/css :dashboard-container :apps-container)}
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :intro)}
       (tr "penforge.apps.intro")]
      (if connected
        [:> apps-grid* {:apps-state apps-state
                        :developer developer
                        :connected connected}]
        [:div {:class (stl/css :connection)}
         [:> connection-banner* {:connection connection}]])]]))
