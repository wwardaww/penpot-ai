;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.device-screens
  "Device screen picker: floats left of the top toolbar and adds a board
  of a real device's screen size (`app.main.devices`) to the canvas."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.workspace.device-screens :as dwds]
   [app.main.devices :as devices]
   [app.main.store :as st]
   [app.main.ui.components.dropdown :refer [dropdown]]
   [app.main.ui.ds.controls.switch :refer [switch*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [rumext.v2 :as mf]))

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

(mf/defc device-screens*
  {::mf/wrap [mf/memo]}
  []
  (let [container-ref (mf/use-ref nil)

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
             (st/emit! (dwds/add-device-boards id {:with-states with-states})))))]

    [:div {:ref container-ref
           :class (stl/css :device-screens)
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
