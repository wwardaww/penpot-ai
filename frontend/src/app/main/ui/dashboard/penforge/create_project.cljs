;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.create-project
  "Penforge create-project panel: project name plus the platform of the
  app (Responsive Web or Mobile App) as two selectable cards. Replaces
  the instant auto named creation when the `:ai` flag is on."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.dashboard :as dd]
   [app.main.data.event :as ev]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.option-cards :refer [option-cards*
                                                        web-illustration*
                                                        mobile-illustration*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.input :refer [input*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def max-name-length 250)

(defn can-create?
  "True when the panel holds a usable name and a platform."
  [name platform]
  (and (string? name)
       (not (str/blank? name))
       (<= (count (str/trim name)) max-name-length)
       (contains? pf/platforms platform)))

(mf/defc create-project-modal*
  {::mf/register modal/components
   ::mf/register-as :penforge-create-project}
  []
  (let [name*     (mf/use-state "")
        name      (deref name*)
        platform* (mf/use-state nil)
        platform  (deref platform*)
        valid     (can-create? name platform)

        options
        (mf/with-memo []
          [{:id :web
            :label (tr "penforge.create-project.platform.web")
            :caption (tr "penforge.create-project.platform.web-caption")
            :illustration (mf/html [:> web-illustration*])}
           {:id :mobile
            :label (tr "penforge.create-project.platform.mobile")
            :caption (tr "penforge.create-project.platform.mobile-caption")
            :illustration (mf/html [:> mobile-illustration*])}])

        on-name-change
        (mf/use-fn
         (fn [event]
           (reset! name* (dom/get-target-val event))))

        on-platform-change
        (mf/use-fn
         (fn [id]
           (reset! platform* id)))

        create
        (mf/use-fn
         (mf/deps name platform valid)
         (fn []
           (when valid
             (st/emit! (-> (dd/create-project {:name (str/trim name)
                                               :platform platform})
                           (with-meta {::ev/origin "dashboard:penforge-create-project"}))
                       (modal/hide)))))

        on-submit
        (mf/use-fn
         (mf/deps create)
         (fn [event]
           (dom/prevent-default event)
           (create)))

        on-cancel
        (mf/use-fn
         (fn [_] (st/emit! (modal/hide))))]

    [:div {:class (stl/css :modal-overlay)}
     [:form {:class (stl/css :modal-container)
             :role "dialog"
             :aria-labelledby "penforge-create-project-title"
             :data-testid "penforge-create-project"
             :on-submit on-submit}

      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-create-project-title"
                     :typography t/headline-medium
                     :class (stl/css :modal-title)}
        (tr "penforge.create-project.title")]
       [:> icon-button* {:variant "ghost"
                         :type "button"
                         :aria-label (tr "labels.close")
                         :icon i/close
                         :on-click on-cancel}]]

      [:div {:class (stl/css :modal-content)}
       [:> input* {:label (tr "penforge.create-project.name")
                   :placeholder (tr "penforge.create-project.name-placeholder")
                   :variant "comfortable"
                   :value name
                   :max-length max-name-length
                   :auto-focus true
                   :data-testid "penforge-create-project-name"
                   :on-change on-name-change}]

       [:div {:class (stl/css :platform)}
        [:> text* {:as "span"
                   :id "penforge-create-project-platform"
                   :typography t/body-medium
                   :class (stl/css :platform-label)}
         (tr "penforge.create-project.platform")]
        [:> option-cards* {:options options
                           :value platform
                           :label (tr "penforge.create-project.platform")
                           :on-change on-platform-change
                           :on-submit create}]]]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :on-click on-cancel}
        (tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :type "submit"
                    :disabled (not valid)
                    :data-testid "penforge-create-project-submit"}
        (tr "penforge.create-project.create")]]]]))
