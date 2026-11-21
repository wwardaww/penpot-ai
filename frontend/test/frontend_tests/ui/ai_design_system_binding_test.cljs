;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-design-system-binding-test
  "Design system binding (W30): the chat card (fix summary, ONE missing
  items list with two buttons, the design system tab's task) and the
  picker list render in each of their states."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.workspace.ai.design-system.binding.card :as card]
   [app.main.ui.workspace.ai.design-system.binding.picker :as picker]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(defn- js-props
  "Shallow JS props (values stay CLJS data, as rumext passes them)."
  [props]
  (let [result #js {}]
    (doseq [[k v] props]
      (unchecked-set result (name k) v))
    result))

(defn- render-card
  [info & {:as props}]
  (rds/renderToStaticMarkup
   (mf/element card/binding-card*
               (js-props (merge {:info info
                                 :canEdit true
                                 :connected true
                                 :onAdd identity :onKeep identity :onDismiss identity}
                                props)))))

(def ^:private items
  [{:id "component:delete-button" :kind "component" :name "Delete button"
    :reason "The list needs a way to remove an item." :source "ai"}
   {:id "component:date-picker" :kind "component" :name "Date picker"
    :reason "The form asks for a date." :source "check"}])

(t/deftest card-renders-nothing-when-there-is-nothing-to-say
  (t/is (= "" (render-card {:binding {:name "Acme DS"}}))))

(t/deftest card-lists-all-missing-items-with-two-buttons
  (let [html (render-card {:binding {:name "Acme DS"} :missing items})]
    (t/is (str/includes? html "data-testid=\"design-system-missing\""))
    (t/is (str/includes? html "Delete button"))
    (t/is (str/includes? html "The form asks for a date."))
    (t/is (= 1 (count (re-seq #"penforge.design-system-binding.missing.add" html))) "one Add button")
    (t/is (= 1 (count (re-seq #"penforge.design-system-binding.missing.keep" html))) "one Don't add button")
    (t/is (str/includes? html "Acme DS"))))

(t/deftest card-buttons-are-disabled-while-working-or-offline
  (let [busy    (render-card {:missing items :running :add :progress "Waiting for the design system tab"})
        offline (render-card {:missing items} :connected false)]
    (t/is (str/includes? busy "Waiting for the design system tab"))
    (t/is (str/includes? busy "disabled"))
    (t/is (str/includes? offline "disabled"))))

(t/deftest card-explains-fixes-and-errors
  (let [html (render-card {:fixed {:fixes [{:code "color" :params {:layer "Card" :from "#1e88e5"
                                                                   :name "color.primary" :to "#1d7fe0"}}]
                                   :findings [{:code "off-shadow" :params {:layer "Card"}}]
                                   :linked 3 :total 1 :summary "I matched"}
                           :error "library-not-updated"})]
    (t/is (str/includes? html "data-testid=\"design-system-fixed\""))
    (t/is (str/includes? html "penforge.design-system-binding.fix.color"))
    (t/is (str/includes? html "penforge.design-system-binding.finding.off-shadow"))
    (t/is (str/includes? html "penforge.design-system-binding.fixed.linked"))
    (t/is (str/includes? html "penforge.design-system-binding.error.library-not-updated"))))

(t/deftest card-in-the-design-system-tab
  (let [pending (render-card {:is-system true :task {:task-id "t" :count 2 :project {:file-name "Shop"}}})
        building (render-card {:is-system true :task {:task-id "t" :count 2} :running :build})
        done (render-card {:is-system true :task-result {:created [{:item-id "a"}] :project {:file-name "Shop"}}})]
    (t/is (str/includes? pending "penforge.design-system-binding.task.pending"))
    (t/is (str/includes? building "penforge.design-system-binding.task.building"))
    (t/is (str/includes? done "penforge.design-system-binding.task.done"))))

(defn- render-list
  [props]
  (rds/renderToStaticMarkup
   (mf/element picker/system-list*
               (js-props (merge {:onSelect identity} props)))))

(t/deftest picker-list-states
  (let [files [{:id #uuid "aa11bb22-cc33-4d44-8e55-ff6677889900" :name "Acme DS" :is-shared true
                :library-summary {:colors {:sample [{:color "#1d7fe0"} {:color "#ffffff"}]}}}
               {:id #uuid "bb22cc33-dd44-4e55-8f66-0077889900aa" :name "Draft DS" :is-shared false}]
        html  (render-list {:files files
                            :selected "aa11bb22-cc33-4d44-8e55-ff6677889900"
                            :current "aa11bb22-cc33-4d44-8e55-ff6677889900"})
        field (render-list {:files files :none true})]
    (t/is (= 2 (count (re-seq #"type=\"radio\"" html))))
    (t/is (str/includes? html "penforge.design-system-binding.picker.current"))
    (t/is (str/includes? html "penforge.design-system-binding.picker.not-published"))
    (t/is (str/includes? html "background-color:#1d7fe0"))
    (t/is (= 3 (count (re-seq #"type=\"radio\"" field))) "None + the systems")
    (t/is (str/includes? field "penforge.design-system-binding.picker.none"))
    (t/is (str/includes? (render-list {:files nil}) "labels.loading"))
    (t/is (str/includes? (render-list {:files []}) "penforge.design-system-binding.picker.empty"))))
