;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.dashboard.penforge.persona
  "Penforge persona chooser (Designer / Developer): the one-time modal
  for profiles that did not get one from onboarding, the gate that opens
  it, and the profile settings section that changes it."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.config :as cf]
   [app.main.data.modal :as modal]
   [app.main.data.penforge :as pf]
   [app.main.refs :as refs]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.option-cards :refer [option-cards*
                                                        designer-illustration*
                                                        developer-illustration*]]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn onboarding-pending?
  "True while the upstream onboarding modals may still show; the
  persona modal waits for them so the two never stack."
  [profile]
  (and (contains? cf/flags :onboarding)
       (not (get-in profile [:props :onboarding-viewed]))))

(defn show-persona-modal?
  [profile modal-open]
  (and (pf/persona-pending? profile)
       (not (onboarding-pending? profile))
       (not modal-open)))

(defn- use-persona-options
  []
  (mf/with-memo []
    [{:id :designer
      :label (tr "penforge.persona.designer")
      :caption (tr "penforge.persona.designer-caption")
      :illustration (mf/html [:> designer-illustration*])}
     {:id :developer
      :label (tr "penforge.persona.developer")
      :caption (tr "penforge.persona.developer-caption")
      :illustration (mf/html [:> developer-illustration*])}]))

(mf/defc persona-modal*
  {::mf/register modal/components
   ::mf/register-as :penforge-persona}
  []
  (let [persona* (mf/use-state nil)
        persona  (deref persona*)
        options  (use-persona-options)

        on-change
        (mf/use-fn
         (fn [id] (reset! persona* id)))

        save
        (mf/use-fn
         (fn [persona]
           (st/emit! (pf/set-persona persona)
                     (modal/hide))))

        on-continue
        (mf/use-fn
         (mf/deps persona save)
         (fn []
           (when (contains? pf/personas persona)
             (save persona))))

        on-skip
        (mf/use-fn
         (mf/deps save)
         (fn [_] (save pf/default-persona)))]

    [:div {:class (stl/css :modal-overlay)}
     [:div {:class (stl/css :modal-container)
            :role "dialog"
            :aria-labelledby "penforge-persona-title"
            :data-testid "penforge-persona"}
      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-persona-title"
                     :typography t/headline-medium
                     :class (stl/css :modal-title)}
        (tr "penforge.persona.title")]
       [:> text* {:as "p"
                  :typography t/body-medium
                  :class (stl/css :modal-subtitle)}
        (tr "penforge.persona.subtitle")]]

      [:> option-cards* {:options options
                         :value persona
                         :label (tr "penforge.persona.title")
                         :on-change on-change
                         :on-submit on-continue}]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "ghost"
                    :type "button"
                    :on-click on-skip}
        (tr "penforge.persona.skip")]
       [:> button* {:variant "primary"
                    :type "button"
                    :disabled (nil? persona)
                    :data-testid "penforge-persona-continue"
                    :on-click on-continue}
        (tr "labels.continue")]]]]))

(def ^:private modal-open-ref
  (l/derived #(some? (::modal/modal %)) st/state))

(mf/defc persona-gate*
  "Renders nothing; opens the persona modal once when the profile has
  no persona and no other onboarding modal is due."
  []
  (let [profile    (mf/deref refs/profile)
        modal-open (mf/deref modal-open-ref)
        show?      (show-persona-modal? profile modal-open)]
    (mf/with-effect [show?]
      (when show?
        (st/emit! (modal/show :penforge-persona {}))))
    nil))

(mf/defc persona-setting*
  "Profile settings section: the persona can be changed at any time."
  []
  (let [profile (mf/deref refs/profile)
        persona (or (pf/get-persona profile) pf/default-persona)
        options (use-persona-options)

        on-change
        (mf/use-fn
         (mf/deps persona)
         (fn [id]
           (when (not= id persona)
             (st/emit! (pf/set-persona id)))))]

    (when (pf/enabled?)
      [:section {:class (stl/css :setting)
                 :aria-labelledby "penforge-persona-setting-title"
                 :data-testid "penforge-persona-setting"}
       [:> heading* {:level 3
                     :id "penforge-persona-setting-title"
                     :typography t/headline-small
                     :class (stl/css :setting-title)}
        (tr "penforge.persona.setting-title")]
       [:> text* {:as "p"
                  :typography t/body-small
                  :class (stl/css :setting-hint)}
        (tr "penforge.persona.setting-hint")]
       [:> option-cards* {:options options
                          :value persona
                          :label (tr "penforge.persona.setting-title")
                          :on-change on-change}]])))
