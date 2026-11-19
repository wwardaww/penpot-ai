;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.header-strip
  "AI actions outside the AI tab: the `:header` scope (right workspace
  header) and the `:island` scope (floating toolbar over the canvas).

  The right header is narrow, so its icon actions sit in one AI menu;
  only `:primary` actions (status CTAs) stay visible as buttons."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions :as actions]
   [app.main.store :as st]
   [app.main.ui.components.dropdown-menu :refer [dropdown-menu*
                                                 dropdown-menu-item*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn- use-scope-items
  "Visible actions of `scope` with their enabled flag, kept in sync with
  the app state."
  [scope]
  (let [registry  (mf/deref actions/registry)
        items-ref (mf/with-memo [registry scope]
                    (l/derived (fn [state]
                                 (->> (actions/get-actions registry scope state)
                                      (mapv (fn [action]
                                              {:action action
                                               :enabled (actions/enabled? action state)}))))
                               st/state
                               =))]
    (mf/deref items-ref)))

(mf/defc primary-action*
  {::mf/private true}
  [{:keys [action enabled scope]}]
  (let [on-click
        (mf/use-fn
         (mf/deps action scope)
         #(actions/run-action action scope))]
    [:> button* {:variant "primary"
                 :class (stl/css :primary-action)
                 :disabled (not enabled)
                 :on-click on-click}
     (actions/get-label action)]))

(mf/defc menu-action*
  {::mf/private true}
  [{:keys [action enabled on-close]}]
  (let [on-click
        (mf/use-fn
         (mf/deps action enabled on-close)
         (fn [_]
           (when enabled
             (on-close)
             (actions/run-action action :header))))
        on-key-down
        (mf/use-fn
         (mf/deps on-click)
         (fn [event]
           (when (kbd/enter? event)
             (on-click event))))]
    [:> dropdown-menu-item* {:class (stl/css-case :menu-item true
                                                  :menu-item-disabled (not enabled))
                             :aria-disabled (not enabled)
                             :on-click on-click
                             :on-key-down on-key-down}
     [:> icon* {:icon-id (or (:icon action) i/effects)
                :size "s"
                :class (stl/css :menu-item-icon)}]
     [:span {:class (stl/css :menu-item-name)}
      (actions/get-label action)]]))

(mf/defc header-strip*
  []
  (let [items             (use-scope-items :header)
        primary-items     (filterv (comp :primary :action) items)
        menu-items        (filterv (comp not :primary :action) items)
        show-menu*        (mf/use-state false)
        show-menu?        (deref show-menu*)
        toggle-menu
        (mf/use-fn
         (fn [event]
           ;; the open menu closes on any document click; keep this one
           ;; from reaching it
           (dom/stop-propagation event)
           (swap! show-menu* not)))
        close-menu
        (mf/use-fn #(reset! show-menu* false))]
    (when (seq items)
      [:div {:class (stl/css :header-strip)}
       (for [{:keys [action enabled]} primary-items]
         [:> primary-action* {:key (str (:id action))
                              :action action
                              :enabled enabled
                              :scope :header}])
       (when (seq menu-items)
         [:div {:class (stl/css :menu-wrapper)}
          [:> icon-button* {:variant "action"
                            :tooltip-placement "bottom-left"
                            :aria-label (tr "penforge.header.ai-menu")
                            :aria-pressed show-menu?
                            :icon i/effects
                            :on-click toggle-menu}]
          [:> dropdown-menu* {:show show-menu?
                              :on-close close-menu
                              :class (stl/css :menu)}
           (for [{:keys [action enabled]} menu-items]
             [:> menu-action* {:key (str (:id action))
                               :action action
                               :enabled enabled
                               :on-close close-menu}])]])])))

(mf/defc island-actions*
  "Primary AI actions of the floating toolbar (the Build CTA)."
  []
  (let [items (use-scope-items :island)]
    (when (seq items)
      [:div {:class (stl/css :island-actions)}
       (for [{:keys [action enabled]} items]
         [:> primary-action* {:key (str (:id action))
                              :action action
                              :enabled enabled
                              :scope :island}])])))
