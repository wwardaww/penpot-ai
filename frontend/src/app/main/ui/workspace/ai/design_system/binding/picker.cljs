;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-system.binding.picker
  "Design system picker (W30): the team's design systems as a list with
  color swatches; only published ones (shared libraries) can be picked.
  The workspace modal links the picked one to the project; the field
  is the same list inside the new-project dialog (with \"None\")."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.common.data.macros :as dm]
   [app.main.data.ai.actions.redesign :as rd]
   [app.main.data.modal :as modal]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.design-systems.page :as ds-page]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.buttons.icon-button :refer [icon-button*]]
   [app.main.ui.ds.foundations.assets.icon :as i]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.util.dom :as dom]
   [app.util.i18n :refer [tr]]
   [beicon.v2.core :as rx]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn use-design-systems
  "The team's design systems, nil while loading."
  [team-id]
  (let [files* (mf/use-state nil)]
    (mf/with-effect [team-id]
      (reset! files* nil)
      (let [subscription (->> (rd/fetch-team-design-systems team-id)
                              (rx/subs! #(reset! files* (vec %))
                                        (fn [_] (reset! files* []))))]
        #(rx/dispose! subscription)))
    (deref files*)))

(mf/defc system-row*
  {::mf/private true}
  [{:keys [file selected current on-select]}]
  (let [{:keys [colors] ds-name :name} (ds-page/card-info file)
        id        (dm/str (:id file))
        enabled?  (rd/selectable? file)
        handle    (mf/use-fn (mf/deps id on-select) (fn [_] (on-select id)))]
    [:li {:class (stl/css-case :row true :row-disabled (not enabled?))}
     [:label {:class (stl/css :row-label)}
      [:input {:type "radio"
               :name "penforge-design-system"
               :value id
               :checked (= selected id)
               :disabled (not enabled?)
               :on-change handle}]
      [:span {:class (stl/css :row-name) :title ds-name} ds-name]
      [:span {:class (stl/css :swatches) :aria-hidden true}
       (for [[index color] (map-indexed vector colors)]
         [:span {:key (dm/str index color)
                 :class (stl/css :swatch)
                 :style {:background-color color}}])]
      (cond
        (= current id)
        [:span {:class (stl/css :badge)} (tr "penforge.design-system-binding.picker.current")]

        (not enabled?)
        [:span {:class (stl/css :hint)} (tr "penforge.design-system-binding.picker.not-published")])]]))

(mf/defc system-list*
  "The list from plain props (rendered by tests too). `files` nil =
  loading; `none` adds a \"None\" row (new-project dialog)."
  [{:keys [files selected current none on-select]}]
  (let [select-none (mf/use-fn (mf/deps on-select) (fn [_] (on-select nil)))]
    (cond
      (nil? files)
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)} (tr "labels.loading")]

      (and (empty? files) (not none))
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
       (tr "penforge.design-system-binding.picker.empty")]

      :else
      [:ul {:class (stl/css :list) :data-testid "design-system-picker-list"}
       (when none
         [:li {:class (stl/css :row)}
          [:label {:class (stl/css :row-label)}
           [:input {:type "radio"
                    :name "penforge-design-system"
                    :value ""
                    :checked (nil? selected)
                    :on-change select-none}]
           [:span {:class (stl/css :row-name)} (tr "penforge.design-system-binding.picker.none")]]])
       (for [file files]
         [:> system-row* {:key (dm/str (:id file))
                          :file file
                          :selected selected
                          :current current
                          :on-select on-select}])])))

(def ^:private ref:context
  (l/derived (fn [state]
               {:team-id (:current-team-id state)
                :current (some-> (rd/binding-of state) :file-id str)})
             st/state
             =))

(mf/defc picker-dialog
  "Modal `:penforge-design-system-picker` (workspace)."
  {::mf/register modal/components
   ::mf/register-as :penforge-design-system-picker}
  []
  (let [{:keys [team-id current]} (mf/deref ref:context)
        files     (use-design-systems team-id)
        selected* (mf/use-state nil)
        selected  (or (deref selected*) current)
        file      (rd/team-file files selected)
        ready?    (and (some? file) (rd/selectable? file) (not= selected current))

        on-cancel (mf/use-fn #(modal/hide!))
        on-select (mf/use-fn #(reset! selected* %))

        on-submit
        (mf/use-fn
         (mf/deps file ready?)
         (fn [event]
           (dom/prevent-default event)
           (when ready?
             (st/emit! (rd/link-design-system (rd/choice file))))))]

    [:div {:class (stl/css :modal-overlay)}
     [:form {:class (stl/css :modal-dialog)
             :role "dialog"
             :aria-labelledby "penforge-ds-picker-title"
             :data-testid "design-system-picker"
             :on-submit on-submit}
      [:> icon-button* {:variant "ghost"
                        :type "button"
                        :tooltip-class (stl/css :close-btn)
                        :aria-label (tr "labels.close")
                        :icon i/close
                        :on-click on-cancel}]
      [:div {:class (stl/css :modal-title) :id "penforge-ds-picker-title"}
       (tr "penforge.design-system-binding.picker.title")]
      [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
       (if (some? current)
         (tr "penforge.design-system-binding.picker.switch-hint")
         (tr "penforge.design-system-binding.picker.hint"))]
      [:> system-list* {:files files
                        :selected selected
                        :current current
                        :on-select on-select}]
      [:div {:class (stl/css :footer)}
       [:> button* {:variant "secondary" :type "button" :on-click on-cancel}
        (tr "labels.cancel")]
       [:> button* {:variant "primary" :type "submit" :disabled (not ready?)}
        (tr "penforge.design-system-binding.picker.use")]]]]))

(mf/defc design-system-field*
  "The picker inside the new-project dialog: `on-change` gets a choice
  `{:file-id :name :project-id :version}` or nil (\"None\")."
  [{:keys [team-id on-change]}]
  (let [files     (use-design-systems team-id)
        selected* (mf/use-state nil)
        selected  (deref selected*)
        on-select
        (mf/use-fn
         (mf/deps files on-change)
         (fn [id]
           (reset! selected* id)
           (on-change (some-> (rd/team-file files id) rd/choice))))]
    (when (seq files)
      [:div {:class (stl/css :field)}
       [:> text* {:as "span" :typography t/body-medium :class (stl/css :field-label)}
        (tr "penforge.design-system-binding.field.label")]
       [:> system-list* {:files files
                         :selected selected
                         :none true
                         :on-select on-select}]])))
