;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-design-system-extract-test
  "Design system from an existing project (W36): the proposal card and
  the name dialog render in each of their states."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.dashboard.penforge.design-systems.from-file :as from-file]
   [app.main.ui.workspace.ai.design-system.extract.card :as card]
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

(def ^:private plan
  {:plan-id "abc123abc123"
   :stats {:screens 5 :components 3 :colors 2 :raw-colors 7 :typographies 2}
   :proposals [{:id "merge:#1e88e5" :kind "merge-colors" :code "merge-colors"
                :params {:count 3 :colors ["#1e88e5" "#1d87e4" "#1f89e6"]} :text "merge"}
               {:id "component:g1" :kind "component" :code "component-variants"
                :params {:name "Card" :count 7 :screens 3 :variants 2} :text "card"}
               {:id "unused:color:c3" :kind "drop-unused" :code "unused-color"
                :params {:name "Pink"} :text "pink"}]})

(defn- render-card
  [props]
  (rds/renderToStaticMarkup
   (mf/element card/extract-card*
               (js-props (merge {:marker {:name "Shop DS"}
                                 :canEdit true
                                 :connected true
                                 :onToggle identity :onAll identity
                                 :onApply identity :onRetry identity}
                                props)))))

(t/deftest card-while-looking
  (let [html (render-card {:extract {:status :planning}})]
    (t/is (str/includes? html "data-testid=\"design-system-extract\""))
    (t/is (str/includes? html "Shop DS"))
    (t/is (str/includes? html "penforge.design-system-extract.looking"))
    (t/is (not (str/includes? html "type=\"checkbox\"")))))

(t/deftest card-lists-proposals-with-a-checkbox-each-and-one-apply
  (let [html (render-card {:extract {:status :ready :plan plan
                                     :checked #{"merge:#1e88e5" "component:g1"}}})]
    (t/is (= 3 (count (re-seq #"type=\"checkbox\"" html))))
    (t/is (= 2 (count (re-seq #"checked=\"\"" html))) "unchecked items show unchecked")
    (t/is (str/includes? html "penforge.design-system-extract.section.colors"))
    (t/is (str/includes? html "penforge.design-system-extract.section.components"))
    (t/is (str/includes? html "penforge.design-system-extract.section.cleanup"))
    (t/is (str/includes? html "penforge.design-system-extract.proposal.merge-colors"))
    (t/is (= 1 (count (re-seq #"penforge.design-system-extract.apply" html))) "one Apply")))

(t/deftest card-after-a-changed-file-and-on-errors
  (let [changed (render-card {:extract {:status :ready :plan plan :checked #{} :notice "plan-changed"}})
        failed  (render-card {:extract {:status :error :error "not-a-copy"}})
        offline (render-card {:connected false :extract {:status :idle}})
        applying (render-card {:extract {:status :applying :plan plan :checked #{} :progress "Creating the tokens"}})]
    (t/is (str/includes? changed "penforge.design-system-extract.error.plan-changed"))
    (t/is (str/includes? failed "penforge.design-system-extract.error.not-a-copy"))
    (t/is (str/includes? failed "penforge.design-system-extract.retry"))
    (t/is (str/includes? offline "penforge.design-system-extract.not-connected"))
    (t/is (str/includes? applying "Creating the tokens"))
    (t/is (str/includes? applying "disabled"))))

(t/deftest stats-line
  (t/is (string? (card/stats-text {:screens 5 :components 3 :raw-colors 7})))
  (t/is (string? (card/stats-text nil))))

(defn- render-form
  [props]
  (rds/renderToStaticMarkup
   (mf/element from-file/from-file-form*
               (js-props (merge {:onSubmit identity :onCancel identity} props)))))

(t/deftest name-dialog-for-one-file-and-for-a-project
  (let [one     (render-form {:file {:id "f1" :name "Home" :project-id "p" :revn 3} :projectName "Shop"})
        several (render-form {:files [{:id "f1" :name "Home"} {:id "f2" :name "Checkout"}] :projectName "Shop"})
        loading (render-form {:projectName "Shop"})
        none    (render-form {:files [] :projectName "Shop"})]
    (t/is (str/includes? one "penforge.design-system-extract.dialog.name"))
    (t/is (str/includes? one "penforge.design-system-extract.dialog.create"))
    (t/is (not (str/includes? one "type=\"radio\"")))
    (t/is (= 2 (count (re-seq #"type=\"radio\"" several))))
    (t/is (str/includes? several "Checkout"))
    (t/is (str/includes? loading "labels.loading"))
    (t/is (str/includes? none "penforge.design-system-extract.dialog.no-files"))))

(t/deftest dashboard-entries
  (t/is (= [{:id 1 :name "a"} {:id 2 :name "B"}]
           (from-file/source-files [{:id 2 :name "B"} {:id 3 :name "c" :deleted-at "x"} {:id 1 :name "a"}])))
  (t/is (not (from-file/project-entry-visible? {:name "Shop" :count 1})))
  (t/is (not (from-file/project-entry-visible? {:name "Design Systems" :count 4}))))
