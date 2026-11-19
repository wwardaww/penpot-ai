;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.device-screens
  "Device screen picker: floats left of the top toolbar island and
  resizes every screen of the page to a real device's screen size
  (`app.main.devices`), or adds a board of that size to an empty page.

  It is the island's sibling in the viewport, not its child: the island
  is centered with `left: 50%`, so the picker puts its right edge at
  `50% + island width / 2 + gap` and follows the island width with a
  ResizeObserver. It hides when the island does."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.workspace.device-screens :as dwds]
   [app.main.data.workspace.path.state :as pst]
   [app.main.devices :as devices]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.components.dropdown :refer [dropdown]]
   [app.main.ui.context :as ctx]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :as i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private island-hidden-ref
  "Mirrors when the top toolbar island hides: collapsed by the user, or
  replaced by the path edition bar."
  (l/derived (fn [state]
               (let [selected (get-in state [:workspace-local :selected])]
                 (boolean
                  (or (get-in state [:workspace-local :hide-toolbar])
                      (and (= 1 (count selected)) (pst/editing? state))
                      (pst/drawing? state)))))
             st/state))

(defn- find-island
  "The top toolbar island among the siblings of `node`."
  [node]
  (some-> node
          (.-parentElement)
          (.querySelector ":scope > [role='toolbar'] [data-testid='toolbar-options']")
          (.closest "[role='toolbar']")))

(defn- group-label
  [group]
  (case group
    :phones    (tr "penforge.devices.group.phones")
    :tablets   (tr "penforge.devices.group.tablets")
    :foldables (tr "penforge.devices.group.foldables")))

(defn size-label
  "`402 × 874`: a device's default size in points."
  [{:keys [width height]}]
  (dm/str width " × " height))

(mf/defc device-group*
  {::mf/private true}
  [{:keys [group on-pick]}]
  (let [items (mf/with-memo [group] (devices/group-devices group))
        label (group-label group)]
    [:section {:class (stl/css :group)
               :aria-label label}
     [:h3 {:class (stl/css :group-title)} label]
     [:ul {:class (stl/css :group-list)}
      (for [{:keys [id] :as device} items]
        [:li {:key (dm/str id)}
         [:button {:class (stl/css :device)
                   :type "button"
                   :data-device-id (name id)
                   :on-click on-pick}
          [:span {:class (stl/css :device-name)} (:name device)]
          [:span {:class (stl/css :device-size)} (size-label device)]]])]]))

(def ^:private screen-count-ref
  "How many screens (top-level boards) the current page has."
  (l/derived (fn [objects] (count (dwds/screen-boards objects)))
             refs/workspace-page-objects))

(mf/defc picker-scope*
  "One line on what a pick does: resize the page's screens, or add a
  board when there is none."
  {::mf/private true}
  []
  (let [screens (mf/deref screen-count-ref)]
    [:p {:class (stl/css :scope)
         :data-testid "device-screens-scope"}
     (if (pos? screens)
       (tr "penforge.devices.scope.resize" (i18n/c screens))
       (tr "penforge.devices.scope.add"))]))

(mf/defc device-picker*
  {::mf/private true}
  []
  (let [container-ref (mf/use-ref nil)

        rulers        (mf/deref refs/rulers?)

        island-width* (mf/use-state nil)
        island-width  (deref island-width*)

        open*         (mf/use-state false)
        open          (deref open*)

        with-states*  (mf/use-state false)
        with-states   (deref with-states*)

        on-toggle
        (mf/use-fn #(swap! open* not))

        on-close
        (mf/use-fn #(reset! open* false))

        on-states-change
        (mf/use-fn #(reset! with-states* %))

        on-pick
        (mf/use-fn
         (mf/deps with-states)
         (fn [event]
           (let [id (-> (dom/get-current-target event)
                        (dom/get-data "device-id")
                        (keyword))]
             (reset! open* false)
             (st/emit! (dwds/pick-device id {:with-states with-states})))))]

    (mf/with-effect []
      (when-let [island (find-island (mf/ref-val container-ref))]
        (let [measure  #(reset! island-width* (.-width (.getBoundingClientRect island)))
              observer (js/ResizeObserver. measure)]
          (measure)
          (.observe observer island)
          #(.disconnect observer))))

    [:div {:ref container-ref
           :class (stl/css-case :device-screens true
                                :no-rulers (not rulers)
                                :measured (some? island-width))
           :style #js {"--island-width" (dm/str (or island-width 0) "px")}
           :data-testid "device-screens"}
     [:button {:class (stl/css-case :trigger true
                                    :open open)
               :type "button"
               :aria-haspopup "dialog"
               :aria-expanded open
               :title (tr "penforge.devices.title")
               :on-click on-toggle}
      [:> icon* {:icon-id i/board :size "m" :class (stl/css :trigger-icon)}]
      [:span {:class (stl/css :trigger-label)} (tr "penforge.devices.trigger")]
      [:> icon* {:icon-id i/arrow-down :size "s" :class (stl/css :trigger-icon)}]]

     [:& dropdown {:show open
                   :on-close on-close
                   :container container-ref}
      [:div {:class (stl/css :panel)
             :role "dialog"
             :aria-label (tr "penforge.devices.title")}
       [:> picker-scope*]
       [:div {:class (stl/css :groups)}
        (for [group devices/groups]
          [:> device-group* {:key (dm/str group)
                             :group group
                             :on-pick on-pick}])]
       [:div {:class (stl/css :footer)}
        [:> switch* {:label (tr "penforge.devices.breakpoints")
                     :default-checked with-states
                     :on-change on-states-change}]
        [:p {:class (stl/css :footer-hint)}
         (tr "penforge.devices.breakpoints-hint")]]]]]))

(mf/defc device-screens*
  {::mf/wrap [mf/memo]}
  []
  (let [read-only? (mf/use-ctx ctx/workspace-read-only?)
        hidden?    (mf/deref island-hidden-ref)]
    (when-not (or ^boolean read-only? hidden?)
      [:> device-picker*])))
