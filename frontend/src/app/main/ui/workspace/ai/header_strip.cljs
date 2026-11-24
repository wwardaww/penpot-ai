;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.header-strip
  "AI actions outside the AI tab: the `:header` scope (right workspace
  header) and the `:island` scope (floating toolbar over the canvas).

  The right header is narrow, so its icon actions sit in one AI menu;
  only `:primary` actions (status CTAs) stay visible as buttons.

  An `:island` action with `:split-of` sits in the dropdown of that
  primary button (W41: Build and Instruct)."
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
   [rumext.v2 :as mf]))

(defn scope-items
  "Visible actions of `scope` in `registry` with their enabled flag,
  label and badge for the app `state` (label and badge may follow the
  state, W34: Build / Update (n) / Up to date)."
  [registry scope state]
  (->> (actions/get-actions registry scope state)
       (mapv (fn [action]
               (cond-> {:action action
                        :enabled (actions/enabled? action state)
                        :label (actions/get-label action)}
                 (fn? (:badge action)) (assoc :badge ((:badge action) state)))))))

(defn split-items
  "Buttons of the floating toolbar: `{:item :menu}` per visible action,
  `:menu` the items of its dropdown (the action itself first), nil when
  no other action belongs to it."
  [items]
  (let [children (group-by (comp :split-of :action) items)]
    (into []
          (comp (remove (comp :split-of :action))
                (map (fn [item]
                       (let [own (get children (get-in item [:action :id]))]
                         {:item item
                          :menu (when (seq own)
                                  (into [item] own))}))))
          items)))

(defn- use-scope-items
  "Visible actions of `scope` with their enabled flag, kept in sync with
  the app state at most once per animation frame. The guards and
  `:visible?`/`:enabled?` fns read the whole state, so recomputing them
  on every state change made each change of an AI script (thousands per
  script) pay for them; batched per frame, a running script pays
  nothing and the menu catches up when the tab can draw again."
  [scope]
  (let [registry (mf/deref actions/registry)
        items*   (mf/use-state #(scope-items registry scope @st/state))]

    (mf/with-effect [registry scope]
      (let [key     (js/Symbol "penforge-ai-actions")
            frame   (volatile! nil)
            refresh (fn []
                      (vreset! frame nil)
                      (let [items (scope-items registry scope @st/state)]
                        (swap! items* #(if (= % items) % items))))]
        (refresh)
        (add-watch st/state key
                   (fn [_ _ _ _]
                     (when (nil? @frame)
                       (vreset! frame (js/requestAnimationFrame refresh)))))
        (fn []
          (remove-watch st/state key)
          (some-> @frame js/cancelAnimationFrame))))

    (deref items*)))

(mf/defc primary-action*
  {::mf/private true}
  [{:keys [action enabled label badge scope]}]
  (let [on-click
        (mf/use-fn
         (mf/deps action scope)
         #(actions/run-action action scope))]
    [:> button* {:variant "primary"
                 :class (stl/css :primary-action)
                 :disabled (not enabled)
                 :on-click on-click}
     label
     (when (some? badge)
       [:span {:class (stl/css :primary-badge)} badge])]))

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
       (for [{:keys [action enabled label badge]} primary-items]
         [:> primary-action* {:key (str (:id action))
                              :action action
                              :enabled enabled
                              :label label
                              :badge badge
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

(mf/defc split-menu-action*
  {::mf/private true}
  [{:keys [action enabled label on-close]}]
  (let [;; Enter on the focused item reaches this through the menu, which
        ;; clicks it
        on-click
        (mf/use-fn
         (mf/deps action enabled on-close)
         (fn [_]
           (when enabled
             (on-close)
             (actions/run-action action :island))))]
    [:> dropdown-menu-item* {:class (stl/css-case :menu-item true
                                                  :menu-item-disabled (not enabled))
                             :aria-disabled (not enabled)
                             :on-click on-click}
     [:> icon* {:icon-id (or (:icon action) i/effects)
                :size "s"
                :class (stl/css :menu-item-icon)}]
     [:span {:class (stl/css :menu-item-name)} label]]))

(mf/defc split-action*
  "Primary action with a dropdown of the actions that belong to it."
  [{:keys [item menu]}]
  (let [{:keys [action enabled label badge]} item
        show-menu*  (mf/use-state false)
        show-menu?  (deref show-menu*)
        toggle-menu
        (mf/use-fn
         (fn [event]
           ;; the open menu closes on any document click; keep this one
           ;; from reaching it
           (dom/stop-propagation event)
           (swap! show-menu* not)))
        close-menu
        (mf/use-fn #(reset! show-menu* false))]
    [:div {:class (stl/css :split)}
     [:> primary-action* {:action action
                          :enabled enabled
                          :label label
                          :badge badge
                          :scope :island}]
     [:> icon-button* {:variant "primary"
                       :class (stl/css :split-toggle)
                       :has-tooltip false
                       :aria-label (tr "penforge.build.menu")
                       :aria-haspopup "menu"
                       :aria-expanded show-menu?
                       :data-testid "penforge-build-menu"
                       :icon i/arrow-down
                       :on-click toggle-menu}]
     [:> dropdown-menu* {:show show-menu?
                         :on-close close-menu
                         :class (stl/css :menu)}
      (for [{:keys [action enabled label]} menu]
        [:> split-menu-action* {:key (str (:id action))
                                :action action
                                :enabled enabled
                                :label label
                                :on-close close-menu}])]]))

(mf/defc island-actions*
  "Primary AI actions of the floating toolbar (the Build CTA)."
  []
  (let [items (use-scope-items :island)]
    (when (seq items)
      [:div {:class (stl/css :island-actions)}
       (for [{:keys [item menu]} (split-items items)]
         (let [{:keys [action enabled label badge]} item]
           (if (some? menu)
             [:> split-action* {:key (str (:id action))
                                :item item
                                :menu menu}]
             [:> primary-action* {:key (str (:id action))
                                  :action action
                                  :enabled enabled
                                  :label label
                                  :badge badge
                                  :scope :island}])))])))
