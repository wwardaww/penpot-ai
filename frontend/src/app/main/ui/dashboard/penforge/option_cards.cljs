;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.option-cards
  "Side by side selectable cards with a large illustration (WAI-ARIA
  radio group). Used by the create-project panel (platform) and the
  persona chooser."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data :as d]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.keyboard :as kbd]
   [rumext.v2 :as mf]))

(defn step-value
  "The value `delta` steps away from `current` in `values`, wrapping
  around. With no current value, the first (or last, going back) one."
  [values current delta]
  (let [values (vec values)
        total  (count values)]
    (when (pos? total)
      (if-let [index (d/index-of values current)]
        (nth values (mod (+ index delta) total))
        (if (neg? delta) (peek values) (first values))))))

(defn- key->delta
  [event]
  (cond
    (or (kbd/right-arrow? event) (kbd/down-arrow? event)) 1
    (or (kbd/left-arrow? event) (kbd/up-arrow? event)) -1
    :else nil))

;; --- Illustrations (decorative, drawn with the current color)

(mf/defc web-illustration*
  []
  [:svg {:view-box "0 0 120 80"
         :aria-hidden true
         :class (stl/css :illustration)}
   ;; Desktop monitor
   [:rect {:x 4 :y 6 :width 86 :height 54 :rx 4 :class (stl/css :shape-fill)}]
   [:rect {:x 4 :y 6 :width 86 :height 54 :rx 4 :class (stl/css :shape-line)}]
   [:path {:d "M4 50h86" :class (stl/css :shape-line)}]
   [:path {:d "M40 60l-3 12M54 60l3 12M30 73h34" :class (stl/css :shape-line)}]
   [:rect {:x 12 :y 14 :width 34 :height 6 :rx 2 :class (stl/css :shape-accent)}]
   [:rect {:x 12 :y 25 :width 50 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]
   [:rect {:x 12 :y 32 :width 42 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]
   ;; Phone in front
   [:rect {:x 86 :y 26 :width 28 :height 50 :rx 5 :class (stl/css :shape-surface)}]
   [:rect {:x 86 :y 26 :width 28 :height 50 :rx 5 :class (stl/css :shape-line)}]
   [:path {:d "M96 31h8" :class (stl/css :shape-line)}]
   [:rect {:x 91 :y 38 :width 18 :height 4 :rx 2 :class (stl/css :shape-accent)}]
   [:rect {:x 91 :y 46 :width 18 :height 2.5 :rx 1.25 :class (stl/css :shape-soft)}]
   [:rect {:x 91 :y 52 :width 13 :height 2.5 :rx 1.25 :class (stl/css :shape-soft)}]])

(mf/defc mobile-illustration*
  []
  [:svg {:view-box "0 0 120 80"
         :aria-hidden true
         :class (stl/css :illustration)}
   [:rect {:x 40 :y 2 :width 40 :height 76 :rx 7 :class (stl/css :shape-fill)}]
   [:rect {:x 40 :y 2 :width 40 :height 76 :rx 7 :class (stl/css :shape-line)}]
   [:rect {:x 53 :y 7 :width 14 :height 4 :rx 2 :class (stl/css :shape-line)}]
   [:rect {:x 47 :y 18 :width 26 :height 6 :rx 2 :class (stl/css :shape-accent)}]
   [:rect {:x 47 :y 29 :width 26 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]
   [:rect {:x 47 :y 36 :width 19 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]
   [:rect {:x 47 :y 46 :width 11 :height 11 :rx 3 :class (stl/css :shape-soft)}]
   [:rect {:x 62 :y 46 :width 11 :height 11 :rx 3 :class (stl/css :shape-soft)}]
   [:path {:d "M53 71h14" :class (stl/css :shape-line)}]])

(mf/defc designer-illustration*
  []
  [:svg {:view-box "0 0 120 80"
         :aria-hidden true
         :class (stl/css :illustration)}
   [:rect {:x 18 :y 12 :width 52 :height 44 :rx 4 :class (stl/css :shape-fill)}]
   [:rect {:x 18 :y 12 :width 52 :height 44 :rx 4 :class (stl/css :shape-dashed)}]
   [:rect {:x 15 :y 9 :width 6 :height 6 :class (stl/css :shape-surface)}]
   [:rect {:x 15 :y 9 :width 6 :height 6 :class (stl/css :shape-line)}]
   [:rect {:x 67 :y 53 :width 6 :height 6 :class (stl/css :shape-surface)}]
   [:rect {:x 67 :y 53 :width 6 :height 6 :class (stl/css :shape-line)}]
   [:circle {:cx 44 :cy 34 :r 11 :class (stl/css :shape-accent)}]
   ;; Pen tool
   [:path {:d "M84 30l18 18-10 22-16-16z" :class (stl/css :shape-surface)}]
   [:path {:d "M84 30l18 18-10 22-16-16zM84 30l8 26" :class (stl/css :shape-line)}]
   [:circle {:cx 92 :cy 56 :r 2.5 :class (stl/css :shape-line)}]])

(mf/defc developer-illustration*
  []
  [:svg {:view-box "0 0 120 80"
         :aria-hidden true
         :class (stl/css :illustration)}
   [:rect {:x 10 :y 8 :width 100 :height 64 :rx 5 :class (stl/css :shape-fill)}]
   [:rect {:x 10 :y 8 :width 100 :height 64 :rx 5 :class (stl/css :shape-line)}]
   [:path {:d "M10 20h100" :class (stl/css :shape-line)}]
   [:circle {:cx 18 :cy 14 :r 1.8 :class (stl/css :shape-accent)}]
   [:circle {:cx 25 :cy 14 :r 1.8 :class (stl/css :shape-soft)}]
   [:circle {:cx 32 :cy 14 :r 1.8 :class (stl/css :shape-soft)}]
   [:path {:d "M28 36l-9 9 9 9M92 36l9 9-9 9M66 32l-12 28" :class (stl/css :shape-line)}]
   [:rect {:x 36 :y 30 :width 14 :height 3 :rx 1.5 :class (stl/css :shape-accent)}]
   [:rect {:x 36 :y 57 :width 24 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]
   [:rect {:x 70 :y 43 :width 16 :height 3 :rx 1.5 :class (stl/css :shape-soft)}]])

;; --- Cards

(mf/defc option-card*
  {::mf/private true}
  [{:keys [id label caption illustration selected focusable on-select]}]
  (let [on-click
        (mf/use-fn
         (mf/deps id on-select)
         (fn [_] (on-select id)))]
    [:div {:role "radio"
           :aria-checked selected
           :tab-index (if focusable 0 -1)
           :data-value (name id)
           :data-testid (str "penforge-option-" (name id))
           :class (stl/css-case :card true
                                :card-selected selected)
           :on-click on-click}
     [:span {:class (stl/css :check)
             :aria-hidden true}
      (when selected
        [:> icon* {:icon-id i/tick :size "s"}])]
     [:div {:class (stl/css :illustration-wrapper)}
      illustration]
     [:> text* {:as "span"
                :typography t/body-large
                :class (stl/css :card-label)}
      label]
     (when caption
       [:> text* {:as "span"
                  :typography t/body-small
                  :class (stl/css :card-caption)}
        caption])]))

(mf/defc option-cards*
  "`options` is a vector of `{:id keyword :label string :caption string
  :illustration element}`; `value` is the selected id or nil. Arrows
  move and select, Space selects, Enter selects or, on the selected
  card, calls the optional `on-submit`."
  [{:keys [options value on-change on-submit label class]}]
  (let [container (mf/use-ref nil)
        values    (mf/with-memo [options] (mapv :id options))

        select-and-focus
        (mf/use-fn
         (mf/deps on-change)
         (fn [id]
           (on-change id)
           (when-let [node (mf/ref-val container)]
             (some->> (dom/query node (str "[data-value='" (name id) "']"))
                      (dom/focus!)))))

        on-key-down
        (mf/use-fn
         (mf/deps values value select-and-focus on-change on-submit)
         (fn [event]
           (if-let [delta (key->delta event)]
             (do
               (dom/prevent-default event)
               (some-> (step-value values value delta) (select-and-focus)))
             (when (or (kbd/space? event) (kbd/enter? event))
               (dom/prevent-default event)
               (when-let [id (some-> (dom/get-target event)
                                     (dom/get-data "value")
                                     (keyword))]
                 (if (and (kbd/enter? event) (= id value) (fn? on-submit))
                   (on-submit)
                   (on-change id)))))))]

    [:div {:role "radiogroup"
           :aria-label label
           :ref container
           :class [class (stl/css :cards)]
           :on-key-down on-key-down}
     (for [{:keys [id] :as option} options]
       [:> option-card* {:key (name id)
                         :id id
                         :label (:label option)
                         :caption (:caption option)
                         :illustration (:illustration option)
                         :selected (= id value)
                         :focusable (if (some? value)
                                      (= id value)
                                      (= id (first values)))
                         :on-select on-change}])]))
