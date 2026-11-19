;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.design-systems.page
  "Dashboard \"Design Systems\" (W29): the sidebar entry, the list of
  the team's design systems (cards with name, color swatches,
  typography sample and component count) and the \"+ Design System\"
  button, which opens an empty design system file in the workspace."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.config :as cf]
   [app.main.data.ai.design-system :as ds]
   [app.main.data.common :as dcm]
   [app.main.fonts :as fonts]
   [app.main.router :as rt]
   [app.main.store :as st]
   [app.main.ui.components.link :refer [link*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [rumext.v2 :as mf]))

(def route :dashboard-design-systems)

(defn enabled?
  []
  (contains? cf/flags :ai))

(defn go-to-design-systems
  [team-id]
  (rt/nav route {:team-id team-id}))

;; --- Sidebar entry

(mf/defc nav-item*
  "Sidebar link to the Design Systems list (only with the `:ai` flag)."
  [{:keys [section team-id]}]
  (let [go (mf/use-fn
            (mf/deps team-id)
            #(st/emit! (go-to-design-systems team-id)))]
    (when (enabled?)
      [:li {:class (stl/css-case :nav-item true
                                 :nav-current (= section route))}
       [:> link* {:action go
                  :keyboard-action go
                  :class (stl/css :nav-link)
                  :data-testid "design-systems-link-sidebar"}
        [:span {:class (stl/css :nav-title)} (tr "penforge.design-systems.title")]]])))

;; --- "+ Design System" button

(mf/defc new-design-system-button*
  "Creates an empty design system and opens it (only with `:ai`)."
  [{:keys [can-edit]}]
  (let [on-click (mf/use-fn #(st/emit! (ds/create-design-system)))]
    (when (and (enabled?) can-edit)
      [:> button* {:variant "secondary"
                   :type "button"
                   :on-click on-click
                   :data-testid "new-design-system-button"}
       (tr "penforge.design-systems.new")])))

;; --- Cards

(defn card-info
  "What a card shows of a design system file (with its library summary)."
  [{:keys [name is-shared library-summary]}]
  (let [colors       (->> (get-in library-summary [:colors :sample])
                          (keep :color)
                          (take 6)
                          (vec))
        typography   (first (get-in library-summary [:typographies :sample]))]
    {:name name
     :shared (true? is-shared)
     :colors colors
     :font-family (:font-family typography)
     :font-id (:font-id typography)
     :components (or (get-in library-summary [:components :count]) 0)
     :variants (or (get-in library-summary [:variants :count]) 0)
     :tokens (or (:tokens-count library-summary) 0)}))

(mf/defc design-system-card*
  [{:keys [file on-open]}]
  (let [{:keys [colors font-family font-id components tokens shared] ds-name :name} (card-info file)
        on-click (mf/use-fn
                  (mf/deps file on-open)
                  #(on-open file))]
    (mf/with-effect [font-id]
      (when font-id
        (fonts/ensure-loaded! font-id)))

    [:li
     [:button {:class (stl/css :card)
               :type "button"
               :title ds-name
               :data-testid "design-system-card"
               :on-click on-click}
      [:span {:class (stl/css :card-name)} ds-name]
      [:span {:class (stl/css :swatches) :aria-hidden true}
       (for [[index color] (map-indexed vector colors)]
         [:span {:key (dm/str index color)
                 :class (stl/css :swatch)
                 :style {:background-color color}}])]
      [:span {:class (stl/css :type-sample)
              :style (when font-family {:font-family font-family})}
       (dm/str "Aa " (or font-family ""))]
      [:span {:class (stl/css :meta)}
       [:span (tr "penforge.design-systems.card.components" components)]
       [:span (tr "penforge.design-systems.card.tokens" tokens)]
       (when shared
         [:span {:class (stl/css :badge)} (tr "penforge.design-systems.card.shared")])]]]))

(mf/defc design-systems-list*
  "The cards, or the empty state."
  [{:keys [files can-edit on-open]}]
  (cond
    (nil? files)
    [:> text* {:as "p" :typography t/body-medium} (tr "labels.loading")]

    (empty? files)
    [:div {:class (stl/css :empty)}
     [:> text* {:as "p" :typography t/body-medium}
      (tr "penforge.design-systems.empty")]
     [:> new-design-system-button* {:can-edit can-edit}]]

    :else
    [:ul {:class (stl/css :grid)}
     (for [file files]
       [:> design-system-card* {:key (dm/str (:id file))
                                :file file
                                :on-open on-open}])]))

;; --- Page

(mf/defc design-systems-page*
  [{:keys [team projects]}]
  (let [team-id  (:id team)
        can-edit (-> team :permissions :can-edit)
        files*   (mf/use-state nil)
        files    (deref files*)

        on-open
        (mf/use-fn
         (mf/deps team-id)
         (fn [file]
           (st/emit! (dcm/go-to-workspace :team-id team-id :file-id (:id file)))))]

    (mf/with-effect [team]
      (dom/set-html-title (tr "penforge.design-systems.title")))

    (mf/with-effect [team-id projects]
      (reset! files* nil)
      (let [subscription (->> (ds/fetch-design-systems projects)
                              (rx/subs! #(reset! files* %)
                                        (fn [_] (reset! files* []))))]
        #(rx/dispose! subscription)))

    [:*
     [:header {:class (stl/css :dashboard-header) :data-testid "dashboard-header"}
      [:div#dashboard-design-systems-title {:class (stl/css :dashboard-title)}
       [:> heading* {:level 1
                     :typography t/title-large
                     :class (stl/css :dashboard-title-text)}
        (tr "penforge.design-systems.title")]]
      [:div {:class (stl/css :dashboard-header-actions)}
       [:> new-design-system-button* {:can-edit can-edit}]]]

     [:section {:class (stl/css :container)}
      [:> design-systems-list* {:files files
                                :can-edit can-edit
                                :on-open on-open}]]]))
