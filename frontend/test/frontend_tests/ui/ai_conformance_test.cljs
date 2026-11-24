;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-conformance-test
  "W35 UI renders: the checklist of the Re-Design confirm card, the
  outcomes of its summary card and the conformance report of the build
  dialog."
  (:require
   ["react-dom/server" :as rds]
   [app.main.ui.workspace.ai.build.conformance :as conformance]
   [app.main.ui.workspace.ai.linked.checklist :as checklist]
   [app.main.ui.workspace.ai.linked.panel :as panel]
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

(defn- render
  [component props]
  (rds/renderToStaticMarkup (mf/element component (js-props props))))

(defn- count-of
  [html text]
  (dec (count (str/split html text))))

(def ^:private menu
  {:key "mobile-menu" :name "Mobile menu" :kind "component" :screens ["Home"]
   :what "Opens the navigation" :why "No menu on phones" :checked true :decided false})

(def ^:private form
  {:key "newsletter-form" :name "Newsletter form" :kind "feature" :screens []
   :what "Collects e-mails" :why "Needs a backend" :checked false :decided false})

;; --- Checklist

(t/deftest checklist-groups-by-kind-with-its-checkboxes
  (let [html (render checklist/checklist* {:items [menu form] :choices {} :onChoose identity})]
    (t/is (str/includes? html "penforge-redesign-checklist"))
    (t/is (str/includes? html "penforge.redesign.checklist.components"))
    (t/is (str/includes? html "penforge.redesign.checklist.features"))
    (t/is (str/includes? html "Mobile menu"))
    (t/is (str/includes? html "No menu on phones"))
    (t/is (= 2 (count-of html "type=\"checkbox\"")))
    (t/is (= 1 (count-of html "checked=\"\"")) "the component starts on, the feature off")
    (t/is (not (str/includes? html "penforge-redesign-decided")))))

(t/deftest checklist-follows-the-choices
  (let [html (render checklist/checklist* {:items [menu form]
                                           :choices {"mobile-menu" false "newsletter-form" false}
                                           :onChoose identity})]
    (t/is (= 0 (count-of html "checked=\"\"")))))

(t/deftest earlier-decisions-are-collapsed-and-changeable
  (let [html (render checklist/checklist* {:items [(assoc menu :decided true)
                                                   (assoc form :decided true)]
                                           :choices {}
                                           :onChoose identity})]
    (t/is (str/includes? html "penforge-redesign-decided"))
    (t/is (str/includes? html "penforge.redesign.checklist.decided"))
    (t/is (not (str/includes? html "penforge.redesign.checklist.intro")) "nothing new to ask")
    (t/is (= 2 (count-of html "type=\"checkbox\""))))
  (t/is (= "" (render checklist/checklist* {:items [] :choices {} :onChoose identity}))))

(defn- render-card
  [redesign]
  (render panel/redesign-card* {:redesign redesign :onConfirm identity :onRetry identity
                                :onCancel identity :onRevert identity :onDismiss identity}))

(t/deftest confirm-card-shows-the-checklist
  (let [html (render-card {:status :confirm :workflow "code-redesign"
                           :plan {:git true :branch "penforge/redesign-x" :screens []
                                  :checklist {:state "ready" :items [menu form]}}})]
    (t/is (str/includes? html "penforge-redesign-checklist"))
    (t/is (str/includes? html "penforge.redesign.action"))
    (t/is (not (str/includes? html "penforge-redesign-compare-failed"))))
  (let [html (render-card {:status :confirm :workflow "code-redesign"
                           :plan {:git true :screens [] :checklist {:state "ready" :items []}}})]
    (t/is (not (str/includes? html "penforge-redesign-checklist")) "no items: the card as before")))

(t/deftest a-failed-comparison-offers-retry-or-look-only
  (let [html (render-card {:status :confirm :workflow "code-redesign"
                           :plan {:git true :screens []
                                  :checklist {:state "failed" :message "no list"}}})]
    (t/is (str/includes? html "penforge-redesign-compare-failed"))
    (t/is (str/includes? html "penforge.redesign.checklist.retry"))
    (t/is (str/includes? html "penforge.redesign.checklist.look-only"))))

(t/deftest planning-shows-the-comparison-and-a-cancel
  (let [html (render-card {:status :planning :workflow "code-redesign" :progress {:step "compare"}})]
    (t/is (str/includes? html "penforge.redesign.step.compare"))
    (t/is (str/includes? html "labels.cancel"))))

(t/deftest summary-says-what-came-of-each-item
  (let [html (render-card {:status :done :workflow "code-redesign"
                           :result {:files-changed [] :screens [] :outside-look []
                                    :items [(assoc menu :outcome "added")
                                            (assoc form :outcome "left-out")
                                            {:key "search" :name "Search" :outcome "not-done"
                                             :note "Needs an index"}]}})]
    (t/is (str/includes? html "penforge-redesign-outcomes"))
    (t/is (str/includes? html "penforge.redesign.item.added"))
    (t/is (str/includes? html "penforge.redesign.item.left-out"))
    (t/is (str/includes? html "penforge.redesign.item.not-done: Needs an index"))))

;; --- Conformance report

(defn- render-report
  [report persona]
  (render conformance/conformance-report* {:conformance report :persona persona}))

(def ^:private link-finding
  {:code "link-missing" :screen "Tasks"
   :params {:source "Plus" :screen "Tasks" :target "Add task" :route "/add-task"}
   :text "\"Plus\" on \"Tasks\" must lead to \"Add task\" (/add-task) on click"})

(t/deftest conformance-report-states
  (t/is (= "" (render-report nil :designer)) "builds without a report show nothing")
  (let [html (render-report {:status "clean" :fixed 2 :left 0 :elsewhere 0 :items [] :skipped []} :designer)]
    (t/is (str/includes? html "penforge.build.conformance.clean"))
    (t/is (str/includes? html "penforge.build.conformance.fixed"))
    (t/is (not (str/includes? html "<details"))))
  (let [report {:status "findings" :fixed 0 :left 3 :elsewhere 4 :items [link-finding]
                :skipped [{:check "values" :reason "no theme"}]}
        html   (render-report report :designer)
        dev    (render-report report :developer)]
    (t/is (str/includes? html "penforge.build.conformance.left"))
    (t/is (str/includes? html "penforge.build.conformance.link-missing"))
    (t/is (str/includes? html "penforge.build.conformance.more"))
    (t/is (str/includes? html "penforge.build.conformance.elsewhere"))
    (t/is (str/includes? html "penforge.build.conformance.skipped"))
    (t/is (not (str/includes? html "/add-task")) "designers see no routes")
    (t/is (str/includes? dev "/add-task")))
  (t/is (str/includes? (render-report {:status "findings" :fixed 0 :left 0 :elsewhere 2 :items [] :skipped []}
                                      :designer)
                       "penforge.build.conformance.clean")
        "what the build touched follows the design")
  (t/is (str/includes? (render-report {:status "unchecked" :items [] :skipped []} :designer)
                       "penforge.build.conformance.unchecked")))

(t/deftest finding-texts
  (t/is (= "penforge.build.conformance.animation-missing"
           (conformance/get-finding-text {:code "animation-missing" :params {} :text "x"} :designer)))
  (t/is (= "technical" (conformance/get-finding-text {:code "new-code" :params {} :text "technical"} :designer))
        "unknown codes keep the daemon's text"))
