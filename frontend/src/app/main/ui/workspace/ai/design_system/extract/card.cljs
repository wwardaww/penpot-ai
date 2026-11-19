;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-system.extract.card
  "Proposal list of a design system made from a project (W36), shown
  above the AI chat of the copy: what the AI found, ONE list of the
  changes it plans (a checkbox each, on by default) and one Apply.
  Progress and the publish question of the apply run show in the chat
  timeline below."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.design-system-extract :as dsx]
   [app.main.data.ai.design-system :as ds]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.controls.checkbox :refer [checkbox*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.util.i18n :as i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:extract
  (l/derived (fn [state]
               (let [marker (ds/current-marker state)]
                 (when (dsx/extract-pending? marker)
                   {:marker    marker
                    :extract   (dsx/current state)
                    :can-edit  (ds/can-edit? state)
                    :connected (= :connected (get-in state [:penforge :connection :status]))})))
             st/state
             =))

(defn stats-text
  "One line about what the inventory found."
  [{:keys [screens components colors raw-colors typographies]}]
  (tr "penforge.design-system-extract.stats"
      (or screens 0) (or components 0) (max (or colors 0) (or raw-colors 0)) (or typographies 0)))

(mf/defc proposal-row*
  {::mf/private true}
  [{:keys [proposal checked disabled on-toggle]}]
  (let [id   (:id proposal)
        text (dsx/proposal-text proposal)
        handle-toggle
        (mf/use-fn (mf/deps id on-toggle) (fn [_] (on-toggle id)))]
    [:li {:class (stl/css :row)}
     [:> checkbox* {:id (str "penforge-dsx-" id)
                    :checked checked
                    :disabled disabled
                    :aria-label text
                    :on-change handle-toggle}]
     [:span {:class (stl/css :row-text)} text]]))

(mf/defc extract-card*
  "The card from plain props (rendered by tests too). `extract` is the
  extraction state (`app.main.data.ai.actions.design-system-extract/
  current`)."
  [{:keys [marker extract can-edit connected on-toggle on-all on-apply on-retry]}]
  (let [{:keys [status plan checked error notice progress]} extract
        proposals (:proposals plan)
        checked   (or checked #{})
        count-on  (count (filter #(contains? checked (:id %)) proposals))
        busy?     (contains? #{:planning :applying} status)
        disabled? (or busy? (not can-edit) (not connected))

        check-all
        (mf/use-fn (mf/deps on-all) (fn [_] (on-all true)))

        check-none
        (mf/use-fn (mf/deps on-all) (fn [_] (on-all false)))]

    [:section {:class (stl/css :card) :data-testid "design-system-extract"}
     [:header {:class (stl/css :header)}
      [:> text* {:as "h3" :typography t/headline-small :class (stl/css :title)}
       (tr "penforge.design-system-extract.title")]
      (when-let [ds-name (:name marker)]
        [:span {:class (stl/css :name) :title ds-name} ds-name])]

     (cond
       (not connected)
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
        (tr "penforge.design-system-extract.not-connected")]

       (not can-edit)
       [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
        (tr "penforge.design-system-extract.read-only")]

       (or (= :idle status) (= :planning status))
       [:div {:class (stl/css :progress) :role "status"}
        [:> loader* {:width 24 :title (tr "penforge.design-system-extract.looking")}]
        [:> text* {:as "p" :typography t/body-medium}
         (tr "penforge.design-system-extract.looking")]]

       (= :error status)
       [:div {:class (stl/css :section)}
        [:p {:class (stl/css :status :status-error) :role "alert"} (dsx/error-text error)]
        [:div {:class (stl/css :actions)}
         [:> button* {:variant "secondary" :type "button" :on-click on-retry}
          (tr "penforge.design-system-extract.retry")]]]

       :else
       [:*
        [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
         (stats-text (:stats plan))]
        (when (= "plan-changed" notice)
          [:p {:class (stl/css :status) :role "status"} (dsx/error-text "plan-changed")])
        (if (empty? proposals)
          [:> text* {:as "p" :typography t/body-medium :class (stl/css :hint)}
           (tr "penforge.design-system-extract.nothing")]
          [:*
           [:div {:class (stl/css :select)}
            [:> button* {:variant "ghost" :type "button" :disabled disabled? :on-click check-all}
             (tr "penforge.design-system-extract.check-all")]
            [:> button* {:variant "ghost" :type "button" :disabled disabled? :on-click check-none}
             (tr "penforge.design-system-extract.check-none")]]
           [:div {:class (stl/css :list)}
            (for [[section items] (dsx/grouped-proposals proposals)]
              [:div {:key (name section) :class (stl/css :section)}
               [:> text* {:as "h4" :typography t/body-large :class (stl/css :section-title)}
                (dsx/section-title section)]
               [:ul {:class (stl/css :rows)}
                (for [proposal items]
                  [:> proposal-row* {:key (:id proposal)
                                     :proposal proposal
                                     :checked (contains? checked (:id proposal))
                                     :disabled disabled?
                                     :on-toggle on-toggle}])]])]])
        (when (= :applying status)
          [:div {:class (stl/css :progress) :role "status"}
           [:> loader* {:width 24 :title (tr "penforge.design-system-extract.applying")}]
           [:> text* {:as "p" :typography t/body-medium}
            (or progress (tr "penforge.design-system-extract.applying"))]])
        [:div {:class (stl/css :actions)}
         [:> button* {:variant "primary"
                      :type "button"
                      :disabled disabled?
                      :on-click on-apply}
          (tr "penforge.design-system-extract.apply" (i18n/c count-on))]]])]))

(mf/defc design-system-extract*
  "The card in a copy whose proposals were not applied yet; renders
  nothing elsewhere. Starts the proposal list on its own."
  []
  (let [data (mf/deref ref:extract)
        status (get-in data [:extract :status])

        on-toggle (mf/use-fn #(st/emit! (dsx/toggle-proposal %)))
        on-all    (mf/use-fn #(st/emit! (dsx/set-all %)))
        on-apply  (mf/use-fn #(st/emit! (dsx/apply-plan)))
        on-retry  (mf/use-fn #(st/emit! (dsx/request-plan)))]

    (mf/with-effect [(some? data) status (:connected data) (:can-edit data)]
      (when (some? data)
        (st/emit! (dsx/maybe-request-plan))))

    (when (some? data)
      [:> extract-card* {:marker (:marker data)
                         :extract (:extract data)
                         :can-edit (:can-edit data)
                         :connected (:connected data)
                         :on-toggle on-toggle
                         :on-all on-all
                         :on-apply on-apply
                         :on-retry on-retry}])))
