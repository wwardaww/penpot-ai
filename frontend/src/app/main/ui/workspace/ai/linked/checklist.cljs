;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.linked.checklist
  "What the design has and the app does not (W35): the checklist the
  user decides before a Re-Design writes code, and what came of each
  item after the run. Plain props, so tests render both."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.redesign-code :as redesign]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(mf/defc checklist-item*
  {::mf/private true}
  [{:keys [item checked on-change]}]
  (let [{:keys [key name what why screens]} item]
    [:li {:class (stl/css :item)}
     [:label {:class (stl/css :item-label)}
      [:input {:type "checkbox"
               :class (stl/css :item-check)
               :checked checked
               :data-key key
               :on-change on-change}]
      [:span {:class (stl/css :item-text)}
       [:span {:class (stl/css :item-name)} name]
       (when (seq what)
         [:span {:class (stl/css :item-detail)} what])
       (when (seq why)
         [:span {:class (stl/css :item-muted)} why])
       (when (seq screens)
         [:span {:class (stl/css :item-muted)}
          (tr "penforge.redesign.checklist.screens" (str/join ", " screens))])]]]))

(mf/defc checklist-group*
  {::mf/private true}
  [{:keys [title hint items choices on-change]}]
  [:section {:class (stl/css :group)}
   (when (some? title)
     [:> text* {:as "h4" :typography t/body-medium :class (stl/css :group-title)} title])
   (when (some? hint)
     [:p {:class (stl/css :item-muted)} hint])
   [:ul {:class (stl/css :items)}
    (for [item items]
      [:> checklist-item* {:key (:key item)
                           :item item
                           :checked (redesign/item-checked? choices item)
                           :on-change on-change}])]])

(mf/defc checklist*
  "Props: `items` of the plan's checklist, `choices` (item key →
  boolean), callback `on-choose` (fn of key and boolean)."
  [{:keys [items choices on-choose]}]
  (let [fresh      (remove :decided items)
        decided    (filter :decided items)
        components (filter #(= "component" (:kind %)) fresh)
        features   (remove #(= "component" (:kind %)) fresh)

        on-change
        (mf/use-fn
         (mf/deps on-choose)
         (fn [event]
           (let [target (dom/get-target event)]
             (on-choose (dom/get-data target "key")
                        (dom/checked? target)))))]

    (when (seq items)
      [:div {:class (stl/css :checklist)
             :data-testid "penforge-redesign-checklist"}
       (when (seq fresh)
         [:p {:class (stl/css :item-detail)} (tr "penforge.redesign.checklist.intro")])
       (when (seq components)
         [:> checklist-group* {:title (tr "penforge.redesign.checklist.components")
                               :hint (tr "penforge.redesign.checklist.components-hint")
                               :items components
                               :choices choices
                               :on-change on-change}])
       (when (seq features)
         [:> checklist-group* {:title (tr "penforge.redesign.checklist.features")
                               :hint (tr "penforge.redesign.checklist.features-hint")
                               :items features
                               :choices choices
                               :on-change on-change}])
       (when (seq decided)
         [:details {:class (stl/css :decided)
                    :data-testid "penforge-redesign-decided"}
          [:summary {:class (stl/css :decided-summary)}
           (tr "penforge.redesign.checklist.decided" (count decided))]
          [:> checklist-group* {:items decided
                                :choices choices
                                :on-change on-change}]])])))

(defn- outcome-text
  [{:keys [outcome]}]
  (case outcome
    "added"    (tr "penforge.redesign.item.added")
    "left-out" (tr "penforge.redesign.item.left-out")
    (tr "penforge.redesign.item.not-done")))

(mf/defc outcomes*
  "What came of each item of the checklist. Props: `items` of the run's
  result."
  [{:keys [items]}]
  (when (seq items)
    [:div {:class (stl/css :group)
           :data-testid "penforge-redesign-outcomes"}
     [:p {:class (stl/css :item-detail)} (tr "penforge.redesign.item.title")]
     [:ul {:class (stl/css :items)}
      (for [{:keys [key name note] :as item} items]
        [:li {:key key :class (stl/css :outcome)}
         [:span {:class (stl/css :item-name)} name]
         [:span {:class (stl/css :item-muted)}
          (str (outcome-text item) (when (seq note) (str ": " note)))]])]]))
