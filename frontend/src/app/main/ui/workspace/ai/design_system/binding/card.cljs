;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.ui.workspace.ai.design-system.binding.card
  "Design system card above the AI chat (W30): what the check fixed and
  why (one summary), the ONE list of items the design system lacks
  with \"Add to design system\" / \"Don't add\", and, in the design
  system tab of an \"Add to design system\" task, what it is doing."
  (:require-macros [app.main.style :as stl])
  (:require
   [app.main.data.ai.actions.redesign :as rd]
   [app.main.store :as st]
   [app.main.ui.ds.buttons.button :refer [button*]]
   [app.main.ui.ds.foundations.assets.icon :as i :refer [icon*]]
   [app.main.ui.ds.foundations.typography :as t]
   [app.main.ui.ds.foundations.typography.text :refer [text*]]
   [app.main.ui.ds.product.loader :refer [loader*]]
   [app.main.ui.workspace.ai.design-system.binding.picker]
   [app.util.i18n :as i18n :refer [tr]]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(def ^:private ref:binding
  (l/derived (fn [state]
               (when-let [s (rd/current state)]
                 {:info     s
                  :can-edit (true? (get-in state [:permissions :can-edit]))
                  :connected (= :connected (get-in state [:penforge :connection :status]))}))
             st/state
             =))

(defn- busy?
  [s]
  (contains? #{:add :keep :link :redesign :check :build} (:running s)))

(mf/defc fixed-section*
  {::mf/private true}
  [{:keys [fixed on-dismiss]}]
  (let [lines (rd/fixed-lines fixed)
        lines (if (seq lines) lines (when-let [s (:summary fixed)] [s]))]
    (when (seq lines)
      [:div {:class (stl/css :section) :data-testid "design-system-fixed"}
       [:div {:class (stl/css :section-header)}
        [:> text* {:as "h4" :typography t/body-large :class (stl/css :section-title)}
         (tr "penforge.design-system-binding.fixed.title" (i18n/c (or (:total fixed) (count lines))))]
        ;; a plain button: the DS icon button's tooltip needs a real document
        [:button {:type "button"
                  :class (stl/css :dismiss)
                  :aria-label (tr "labels.close")
                  :title (tr "labels.close")
                  :on-click on-dismiss}
         [:> icon* {:icon-id i/close :size "s"}]]]
       [:ul {:class (stl/css :lines)}
        (for [[index line] (map-indexed vector (take 12 lines))]
          [:li {:key index :class (stl/css :line)} line])]
       (when (pos? (or (:linked fixed) 0))
         [:p {:class (stl/css :hint)}
          (tr "penforge.design-system-binding.fixed.linked" (i18n/c (:linked fixed)))])])))

(mf/defc missing-section*
  {::mf/private true}
  [{:keys [items disabled on-add on-keep]}]
  [:div {:class (stl/css :section) :data-testid "design-system-missing"}
   [:> text* {:as "h4" :typography t/body-large :class (stl/css :section-title)}
    (tr "penforge.design-system-binding.missing.title" (i18n/c (count items)))]
   [:> text* {:as "p" :typography t/body-small :class (stl/css :hint)}
    (tr "penforge.design-system-binding.missing.hint")]
   [:ul {:class (stl/css :items)}
    (for [item items]
      [:li {:key (:id item) :class (stl/css :item)}
       [:span {:class (stl/css :item-name)} (:name item)]
       (when-let [reason (not-empty (:reason item))]
         [:span {:class (stl/css :item-reason)} reason])])]
   [:div {:class (stl/css :actions)}
    [:> button* {:variant "secondary" :type "button" :disabled disabled :on-click on-keep}
     (tr "penforge.design-system-binding.missing.keep")]
    [:> button* {:variant "primary" :type "button" :disabled disabled :on-click on-add}
     (tr "penforge.design-system-binding.missing.add")]]])

(mf/defc binding-card*
  "The card from plain props (rendered by tests too). `info` is the
  binding state (`app.main.data.ai.actions.redesign/current`)."
  [{:keys [info can-edit connected on-add on-keep on-dismiss]}]
  (let [{:keys [fixed missing error running progress task task-result is-system]} info
        items     (vec missing)
        disabled? (or (not can-edit) (not connected) (busy? info))]
    (when (or (some? fixed) (seq items) (some? error) (some? task) (some? task-result))
      [:section {:class (stl/css :card) :data-testid "design-system-binding"}
       [:header {:class (stl/css :header)}
        [:> text* {:as "h3" :typography t/headline-small :class (stl/css :title)}
         (tr "penforge.design-system-binding.card.title")]
        (when-let [ds-name (get-in info [:binding :name])]
          [:span {:class (stl/css :name) :title ds-name} ds-name])]

       (when (or is-system (some? task) (some? task-result))
         (cond
           (some? task-result)
           [:p {:class (stl/css :status) :role "status"}
            (tr "penforge.design-system-binding.task.done"
                (count (:created task-result)) (or (get-in task-result [:project :file-name]) ""))]

           (= :build running)
           [:div {:class (stl/css :progress) :role "status"}
            [:> loader* {:width 24 :title (tr "penforge.design-system-binding.task.building")}]
            [:> text* {:as "p" :typography t/body-medium}
             (or progress (tr "penforge.design-system-binding.task.building"))]]

           (some? task)
           [:p {:class (stl/css :status) :role "status"}
            (tr "penforge.design-system-binding.task.pending"
                (or (:count task) 0) (or (get-in task [:project :file-name]) ""))]))

       (when (some? error)
         [:p {:class (stl/css :status :status-error) :role "alert"} (rd/failed-text error)])

       (when (some? fixed)
         [:> fixed-section* {:fixed fixed :on-dismiss on-dismiss}])

       (when (seq items)
         [:> missing-section* {:items items
                               :disabled disabled?
                               :on-add on-add
                               :on-keep on-keep}])

       (when (contains? #{:add :keep} running)
         [:div {:class (stl/css :progress) :role "status"}
          [:> loader* {:width 24 :title (tr "penforge.design-system-binding.missing.working")}]
          [:> text* {:as "p" :typography t/body-medium}
           (or progress (tr "penforge.design-system-binding.missing.working"))]])])))

(mf/defc design-system-binding*
  "The card of the open file; renders nothing when there is nothing to
  say."
  []
  (let [data (mf/deref ref:binding)
        items (get-in data [:info :missing])
        ids   (mapv :id items)

        on-add     (mf/use-fn (mf/deps ids) #(st/emit! (rd/add-missing ids)))
        on-keep    (mf/use-fn (mf/deps ids) #(st/emit! (rd/keep-missing ids)))
        on-dismiss (mf/use-fn #(st/emit! (rd/dismiss-fixed)))]
    (when (some? data)
      [:> binding-card* {:info (:info data)
                         :can-edit (:can-edit data)
                         :connected (:connected data)
                         :on-add on-add
                         :on-keep on-keep
                         :on-dismiss on-dismiss}])))
