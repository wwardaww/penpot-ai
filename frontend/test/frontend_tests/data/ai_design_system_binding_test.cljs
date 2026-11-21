;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-design-system-binding-test
  "Design system binding (W30): run state folding, the check messages
  of chat turns and design workflows, translated fix lines, the action
  guards and the choice of a dashboard design system."
  (:require
   [app.config :as cf]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.redesign :as rd]
   [cljs.test :as t :include-macros true]))

(def ^:private file-id #uuid "0f1e2d3c-4b5a-4697-8877-665544332211")

(def ^:private bound
  {:file-id "aa11bb22-cc33-4d44-8e55-ff6677889900"
   :name "Acme DS"
   :project-id "6b7c8d9e-2222-4333-8444-a55566667777"
   :redesign-pending true})

(defn- state-with
  [s]
  {:current-file-id file-id
   :permissions {:can-edit true}
   :penforge {:design-system-binding (assoc s :file-id file-id)}})

(t/deftest current-only-for-the-open-file
  (t/is (= "Acme DS" (:name (rd/binding-of (state-with {:binding bound})))))
  (t/is (nil? (rd/current {:current-file-id (random-uuid)
                           :penforge {:design-system-binding {:file-id file-id :binding bound}}})))
  (t/is (rd/bound? (state-with {:binding bound})))
  (t/is (rd/redesign-pending? (state-with {:binding bound})))
  (t/is (not (rd/redesign-pending? (state-with {:binding (assoc bound :redesign-pending false)})))))

(t/deftest status-link-and-redesign-results-fold-in
  (let [s (rd/next-state {} :status {:type "workflow.event" :kind "result"
                                     :payload {:binding bound :file-linked true :is-system false
                                               :missing [{:id "component:date-picker" :name "Date picker"}]}})]
    (t/is (:loaded s))
    (t/is (= bound (:binding s)))
    (t/is (= 1 (count (rd/open-items s))))
    (let [s (rd/next-state s :redesign {:type "workflow.event" :kind "result"
                                        :payload {:fixes [{:code "color" :params {:layer "Card"}}]
                                                  :findings [] :linked 2 :total 1 :summary "Applied"}})]
      (t/is (false? (get-in s [:binding :redesign-pending])))
      (t/is (= 1 (:total (:fixed s))))
      (t/is (= 2 (:linked (:fixed s)))))))

(t/deftest keep-and-add-remove-decided-items
  (let [s {:missing [{:id "component:a" :name "A"} {:id "component:b" :name "B"}]}]
    (t/is (= ["component:b"]
             (map :id (:missing (rd/next-state s :keep {:type "workflow.event" :kind "result"
                                                        :payload {:kept ["component:a"]}})))))
    (t/is (= ["component:a"]
             (map :id (:missing (rd/next-state s :add {:type "workflow.event" :kind "result"
                                                       :payload {:created [{:item-id "component:b"
                                                                            :component-id "c1"}]}})))))))

(t/deftest run-lifecycle-and-errors
  (let [s (rd/next-state {} :add {:type "workflow.started" :rid "r" :run-id "x" :name "design-system-missing"})
        s (rd/next-state s :add {:type "workflow.event" :kind "progress" :payload {:text "Waiting"}})]
    (t/is (= :add (:running s)))
    (t/is (= "Waiting" (:progress s)))
    (let [failed (-> s
                     (rd/next-state :add {:type "workflow.event" :kind "failed" :payload {:code "timeout"}})
                     (rd/next-state :add {:type "workflow.done" :ok false :summary "x"}))]
      (t/is (nil? (:running failed)))
      (t/is (= "timeout" (:error failed))))
    (t/is (= "internal" (:error (rd/next-state s :add {:type "workflow.done" :ok false :summary "x"}))))
    (t/is (= "busy" (:error (rd/next-state s :add {:type "error" :code "busy"}))))))

(t/deftest check-messages-of-chat-turns-and-workflows
  (let [tool {:type "chat.tool" :tool-name rd/check-tool :code rd/fixed-code :summary "I matched…"
              :params {:fixes [{:code "color" :params {:layer "Card" :from "#1e88e5" :name "color.primary" :to "#1d7fe0"}}]
                       :findings [{:code "off-shadow" :params {:layer "Card"}}]
                       :linked 0 :total 1}}
        log  {:type "workflow.event" :kind "log"
              :payload {:code rd/missing-code :text "missing"
                        :params {:items [{:id "component:x" :name "X" :reason "Needed"}]}}}
        s    (-> {} (rd/fold-check tool) (rd/fold-check log))]
    (t/is (= "I matched…" (get-in s [:fixed :summary])))
    (t/is (= 2 (count (rd/fixed-lines (:fixed s)))) "a fix line and a finding line")
    (t/is (= ["X"] (map :name (:missing s))))
    (t/is (= s (rd/fold-check s {:type "chat.tool" :tool-name "other" :code rd/fixed-code})) "other tools ignored")))

(t/deftest fix-and-finding-texts
  (t/is (string? (rd/fix-text {:code "typography" :params {:layer "Title" :from "Inter 23 / 700"
                                                           :name "Title" :to "Inter 24 / 700"}})))
  (t/is (string? (rd/fix-text {:code "swap" :params {:layer "Card" :from "Card" :name "Card"}})))
  (t/is (nil? (rd/fix-text {:code "color-linked" :params {}})) "quiet fixes are not listed")
  (t/is (string? (rd/finding-text {:code "off-color" :params {:layer "Sticker" :from "#ff00aa"}})))
  (t/is (nil? (rd/finding-text {:code "unknown" :params {}})))
  (t/is (string? (rd/failed-text "library-not-updated")))
  (t/is (string? (rd/failed-text "anything-else"))))

(t/deftest choice-of-a-dashboard-file
  (t/is (= {:file-id "aa11bb22-cc33-4d44-8e55-ff6677889900" :name "Acme DS"
            :project-id "6b7c8d9e-2222-4333-8444-a55566667777" :version 12}
           (rd/choice {:id #uuid "aa11bb22-cc33-4d44-8e55-ff6677889900" :name "Acme DS"
                       :project-id #uuid "6b7c8d9e-2222-4333-8444-a55566667777" :revn 12})))
  (t/is (rd/selectable? {:is-shared true}))
  (t/is (not (rd/selectable? {:is-shared false})))
  (t/is (= "b" (:name (rd/team-file [{:id #uuid "aa11bb22-cc33-4d44-8e55-ff6677889900" :name "b"}]
                                    "aa11bb22-cc33-4d44-8e55-ff6677889900")))))

(t/deftest actions-are-registered-with-their-guards
  (let [registry @actions/registry
        pick     (get registry :ai/design-system-pick)
        apply-ds (get registry :ai/design-system-apply)
        check    (get registry :ai/design-system-check)]
    (t/is (some? pick))
    (t/is (contains? (:scopes apply-ds) :header) "Apply design system sits in the AI menu")
    (t/is (not= :redesign-code (:id apply-ds)) "not W38's code Re-Design")
    (with-redefs [cf/flags #{:ai}]
      (let [pending (state-with {:binding bound})
            none    (state-with {})]
        (t/is ((:visible? pick) none))
        (t/is ((:visible? apply-ds) pending))
        (t/is (not ((:visible? apply-ds) (state-with {:binding (assoc bound :redesign-pending false)}))))
        (t/is (not ((:visible? apply-ds) none)))
        (t/is ((:visible? check) pending))
        (t/is (not ((:visible? check) none)))))))
