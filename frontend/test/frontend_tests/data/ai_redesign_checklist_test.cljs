;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-redesign-checklist-test
  "Checklist before a Re-Design (W35): the items of a plan, the user's
  choices as params of the run, retry and cancel of the plan."
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.ai.actions.redesign-code :as redesign]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [potok.v2.core :as ptk]))

(def ^:private menu
  {:key "mobile-menu" :name "Mobile menu" :kind "component" :screens ["Home"]
   :what "Opens the navigation" :why "No menu on phones" :checked true :decided false})

(def ^:private form
  {:key "newsletter-form" :name "Newsletter form" :kind "feature" :screens ["Home"]
   :what "Collects e-mails" :why "Needs a backend" :checked false :decided false})

(def ^:private plan
  {:action "plan" :git true :branch "penforge/redesign-x" :screens []
   :checklist {:state "ready" :items [menu form]}})

(defn- state-of
  [redesign]
  {:current-project-id (uuid/next)
   :penforge {:linked {:redesign (merge {:workflow "code-redesign"} redesign)}}})

(defn- collect
  "Events a watch event emits, in order."
  [event state]
  (let [result (atom [])]
    (rx/sub! (ptk/watch event state (rx/empty)) #(swap! result conj %))
    @result))

(t/deftest checklist-of-a-plan
  (t/is (= [menu form] (redesign/checklist-items plan)))
  (t/is (= [] (redesign/checklist-items {:checklist {:state "failed" :message "no"}})))
  (t/is (= [] (redesign/checklist-items {:git true})) "a Game UI plan has no checklist")
  (t/is (redesign/checklist-failed? {:checklist {:state "failed"}}))
  (t/is (not (redesign/checklist-failed? plan))))

(t/deftest choices-start-from-the-plan-and-follow-the-user
  (t/is (= [{:key "mobile-menu" :build true} {:key "newsletter-form" :build false}]
           (redesign/get-decisions plan nil))
        "components are on, features off")
  (t/is (= [{:key "mobile-menu" :build false} {:key "newsletter-form" :build true}]
           (redesign/get-decisions plan {"mobile-menu" false "newsletter-form" true})))
  (t/is (= [] (redesign/get-decisions {:checklist {:state "failed"}} {"mobile-menu" true}))
        "a failed comparison decides nothing"))

(t/deftest confirm-and-retry-need-the-confirm-card
  (t/is (= 1 (count (collect (redesign/confirm-redesign "" {}) (state-of {:status :confirm :plan plan})))))
  (t/is (empty? (collect (redesign/confirm-redesign "" {}) (state-of {:status :running :plan plan}))))
  (t/is (= 1 (count (collect (redesign/retry-plan) (state-of {:status :confirm :plan plan})))))
  (t/is (empty? (collect (redesign/retry-plan) (state-of {:status :done})))))

(t/deftest cancel-stops-following-the-plan
  (let [state  (ptk/update (redesign/cancel-plan) (state-of {:status :planning :rid "r1" :run-id "run-1"}))
        after  (redesign/get-redesign state)
        second (ptk/update (redesign/cancel-plan) (state-of {:status :running :rid "r1"}))]
    (t/is (= :cancelled (:status after)))
    (t/is (nil? (:rid after)) "later messages of the plan are ignored")
    (t/is (= 1 (count (collect (redesign/cancel-plan) state))) "the workflow is cancelled")
    (t/is (= :running (:status (redesign/get-redesign second))) "a run is not stopped this way")))

(t/deftest the-comparison-shows-its-progress
  (let [redesign (redesign/apply-redesign-message
                  {:status :planning :workflow "code-redesign"}
                  {:type "workflow.event" :kind "progress"
                   :payload {:step "compare" :text "Comparing the design with the app"}})]
    (t/is (= "compare" (get-in redesign [:progress :step])))))

(t/deftest summary-carries-the-outcomes
  (let [items [{:key "mobile-menu" :name "Mobile menu" :kind "component" :outcome "added"}]]
    (t/is (= items (:items (redesign/summary-data "code-redesign" {:items items}))))))
