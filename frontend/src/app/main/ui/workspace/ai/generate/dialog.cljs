;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.generate.dialog
  "Penforge \"Generate screen\" dialog: what to design, the platform
  (defaults to the project platform) and whether the selected layers
  are a reference. Opened by the `:ai/generate-screen` action, which
  passes the submit function."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.controls.radio-buttons :refer [radio-buttons*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.heading :refer [heading*]]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [app.util.keyboard :as kbd]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def max-prompt-length 4000)

(defn can-generate?
  "True when the prompt holds something to design and fits the limit."
  [prompt]
  (and (string? prompt)
       (not (str/blank? prompt))
       (<= (count (str/trim prompt)) max-prompt-length)))

(defn- valid-platform
  [platform]
  (if (contains? #{:web :mobile} platform) platform :web))

(mf/defc generate-screen-dialog*
  "The dialog. Props (single-word keys, they arrive through the modal
  registry): `platform` default platform keyword, `selection` ids of
  the selected layers, `page` current page id, `submit` fn receiving
  `{:prompt :platform :page-id :reference-ids}`."
  {::mf/register modal/components
   ::mf/register-as :penforge-generate-screen}
  [{:keys [platform selection page submit]}]
  (let [prompt*      (mf/use-state "")
        prompt       (deref prompt*)
        platform*    (mf/use-state #(valid-platform platform))
        platform'    (deref platform*)
        reference*   (mf/use-state false)
        reference?   (deref reference*)
        selection    (vec selection)
        has-selection (boolean (seq selection))
        valid        (can-generate? prompt)

        platform-options
        (mf/with-memo []
          [{:id "penforge-generate-platform-web"
            :label (tr "penforge.generate.platform.web")
            :value "web"}
           {:id "penforge-generate-platform-mobile"
            :label (tr "penforge.generate.platform.mobile")
            :value "mobile"}])

        on-prompt-change
        (mf/use-fn
         (fn [event]
           (reset! prompt* (dom/get-target-val event))))

        on-platform-change
        (mf/use-fn
         (fn [value]
           (reset! platform* (keyword value))))

        on-reference-change
        (mf/use-fn
         (fn [_]
           (swap! reference* not)))

        generate
        (mf/use-fn
         (mf/deps prompt platform' reference? selection page submit valid)
         (fn []
           (when valid
             (st/emit! (modal/hide))
             (when (fn? submit)
               (submit {:prompt (str/trim prompt)
                        :platform platform'
                        :page-id page
                        :reference-ids (when reference? selection)})))))

        on-submit
        (mf/use-fn
         (mf/deps generate)
         (fn [event]
           (dom/prevent-default event)
           (generate)))

        on-prompt-key-down
        (mf/use-fn
         (mf/deps generate)
         (fn [event]
           (when (and (kbd/enter? event) (kbd/mod? event))
             (dom/prevent-default event)
             (generate))))

        on-cancel
        (mf/use-fn
         (fn [_] (st/emit! (modal/hide))))]

    [:div {:class (stl/css :modal-overlay)}
     [:form {:class (stl/css :modal-container)
             :role "dialog"
             :aria-labelledby "penforge-generate-title"
             :data-testid "penforge-generate-screen"
             :on-submit on-submit}

      [:div {:class (stl/css :modal-header)}
       [:> heading* {:level 2
                     :id "penforge-generate-title"
                     :typography t/headline-medium
                     :class (stl/css :modal-title)}
        (tr "penforge.generate.title")]
       [:> icon-button* {:variant "ghost"
                         :type "button"
                         :aria-label (tr "labels.close")
                         :icon i/close
                         :on-click on-cancel}]]

      [:div {:class (stl/css :modal-content)}
       [:label {:class (stl/css :field)}
        [:> text* {:as "span"
                   :typography t/body-medium
                   :class (stl/css :field-label)}
         (tr "penforge.generate.prompt")]
        [:textarea {:class (stl/css :prompt)
                    :value prompt
                    :placeholder (tr "penforge.generate.prompt-placeholder")
                    :max-length max-prompt-length
                    :rows 4
                    :auto-focus true
                    :data-testid "penforge-generate-prompt"
                    :on-change on-prompt-change
                    :on-key-down on-prompt-key-down}]]

       [:div {:class (stl/css :field)}
        [:> text* {:as "span"
                   :typography t/body-medium
                   :class (stl/css :field-label)}
         (tr "penforge.generate.platform")]
        [:> radio-buttons* {:name "penforge-generate-platform"
                            :selected (name platform')
                            :options platform-options
                            :on-change on-platform-change}]]

       [:> checkbox* {:id "penforge-generate-reference"
                      :label (if has-selection
                               (tr "penforge.generate.use-selection" (count selection))
                               (tr "penforge.generate.use-selection-empty"))
                      :checked (and has-selection reference?)
                      :disabled (not has-selection)
                      :on-change on-reference-change}]

       [:> text* {:as "p"
                  :typography t/body-small
                  :class (stl/css :hint)}
        (tr "penforge.generate.hint")]]

      [:div {:class (stl/css :modal-footer)}
       [:> button* {:variant "secondary"
                    :type "button"
                    :on-click on-cancel}
        (tr "labels.cancel")]
       [:> button* {:variant "primary"
                    :type "submit"
                    :disabled (not valid)
                    :data-testid "penforge-generate-submit"}
        (tr "penforge.generate.submit")]]]]))
