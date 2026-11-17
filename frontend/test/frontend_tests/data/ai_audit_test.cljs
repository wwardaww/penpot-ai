;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-audit-test
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom/server" :as rds]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.audit :as audit]
   [app.main.ui.workspace.ai.audit.panel :as panel]
   [app.util.globals :as globals]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [rumext.v2 :as mf]))

(def ^:private finding-contrast
  {:id "contrast:text-hint"
   :check "contrast"
   :severity "error"
   :node-id "text-hint"
   :node-name "Hint"
   :board-id "board-login"
   :board-name "Login"
   :title "Low contrast"
   :message "\"Forgot your password?\" has a contrast of 1.9:1."
   :suggestion "Use a text color such as #767676."
   :thread-id "thread-1"
   :duplicate false})

(def ^:private finding-target
  {:id "touch-target:close-button"
   :check "touch-target"
   :severity "warning"
   :node-id "close-button"
   :node-name "Close"
   :board-id "board-login"
   :board-name "Login"
   :title "Small tap target"
   :message "\"Close\" is 20×20 px."
   :suggestion "Make it at least 24×24 px."
   :thread-id "thread-2"
   :duplicate true})

(def ^:private result
  {:mode "audit"
   :page-id "page-1"
   :page-name "Home"
   :boards [{:id "board-login" :name "Login"}]
   :node-count 5
   :counts {:error 1 :warning 1 :info 0}
   :comments {:posted 1 :duplicates 1 :over-limit 0}
   :report {:path "design/audits/2026-11-17.md" :commit "c0ffee"}
   :findings [finding-contrast finding-target]})

(t/deftest apply-run-message-follows-a-run
  (let [state (-> {:status :running :mode :audit :rid "r1"}
                  (audit/apply-run-message {:type "workflow.started" :rid "r1" :run-id "run-1" :name "audit"})
                  (audit/apply-run-message {:type "workflow.event" :run-id "run-1" :kind "progress"
                                            :payload {:summary "Reading the design"}}))]
    (t/is (= "run-1" (:run-id state)))
    (t/is (= "Reading the design" (:progress state)))
    (let [done (-> state
                   (audit/apply-run-message {:type "workflow.event" :run-id "run-1" :kind "result" :payload result})
                   (audit/apply-run-message {:type "workflow.done" :run-id "run-1" :ok true :summary "Audit of Home"}))]
      (t/is (= :done (:status done)))
      (t/is (= result (:result done)))
      (t/is (nil? (:progress done)))
      (t/is (= "Audit of Home" (:summary done))))))

(t/deftest apply-run-message-keeps-fix-results-apart
  (let [fix   {:mode "fix" :page-id "page-1" :fixed ["thread-1"] :remaining ["thread-2"]}
        state (audit/apply-run-message {:status :running :mode :fix :result result}
                                       {:type "workflow.event" :run-id "run-2" :kind "result" :payload fix})]
    (t/is (= result (:result state)))
    (t/is (= fix (:fix-result state)))))

(t/deftest apply-run-message-records-failures
  (t/is (= {:status :error :error "cancelled" :summary "Stopped"}
           (-> (audit/apply-run-message {:status :running :progress "x"}
                                        {:type "workflow.done" :run-id "r" :ok false
                                         :summary "Stopped" :error "cancelled"})
               (select-keys [:status :error :summary]))))
  (t/is (= {:status :error :error "Unknown workflow" :error-code "unknown-workflow"}
           (-> (audit/apply-run-message {:status :running}
                                        {:type "error" :rid "r" :code "unknown-workflow"
                                         :message "Unknown workflow"})
               (select-keys [:status :error :error-code])))))

(t/deftest groups-findings-and-collects-threads
  (t/is (= [["error" [finding-contrast]] ["warning" [finding-target]]]
           (audit/group-findings [finding-target finding-contrast])))
  (t/is (= [] (audit/group-findings [])))
  (t/is (= ["thread-1" "thread-2"]
           (audit/fixable-thread-ids (update result :findings conj (assoc finding-target :id "x"))))))

(t/deftest audit-action-is-registered
  (let [action (get @actions/registry :ai/audit)]
    (t/is (some? action))
    (t/is (= #{:context-menu :main-menu :header :command-palette} (:scopes action)))))

(defn- render
  [element]
  (rds/renderToStaticMarkup element))

(t/deftest content-renders-findings-by-severity
  (let [html (render (mf/element panel/audit-content*
                                 #js {:audit {:status :done :mode :audit :result result :params {:ai false}}
                                      :persona :developer
                                      :onSelect identity
                                      :onAiChange identity}))]
    (t/is (str/includes? html "Low contrast"))
    (t/is (str/includes? html "Small tap target"))
    (t/is (str/includes? html "Login › Hint"))
    (t/is (str/includes? html "contrast · text-hint"))
    (t/is (< (str/index-of html "Low contrast") (str/index-of html "Small tap target")))))

(t/deftest content-renders-running-error-and-empty-states
  (let [running (render (mf/element panel/audit-content*
                                    #js {:audit {:status :running :mode :audit :progress "Reading the design"}
                                         :persona :designer
                                         :onSelect identity
                                         :onAiChange identity}))
        failed  (render (mf/element panel/audit-content*
                                    #js {:audit {:status :error :error-code "not-connected"}
                                         :persona :designer
                                         :onSelect identity
                                         :onAiChange identity}))
        empty   (render (mf/element panel/audit-content*
                                    #js {:audit {:status :done :result (assoc result :findings [])}
                                         :persona :designer
                                         :onSelect identity
                                         :onAiChange identity}))]
    (t/is (str/includes? running "Reading the design"))
    (t/is (str/includes? failed "penforge.audit.not-connected"))
    (t/is (str/includes? empty "penforge.audit.no-findings"))
    (t/is (not (str/includes? empty "contrast · ")))))

(t/deftest ^:async panel-renders-from-the-store
  ;; the full panel has tooltips, which need a document
  (let [dom    (JSDOM. "<!doctype html><html><body></body></html>")
        window (.-window dom)
        state  {:status :done :mode :audit :result result :params {:ai true}}]
    (await
     (mock/with-mocks* {globals/document (.-document window)
                        globals/window window
                        panel/ref:audit (atom state)
                        panel/ref:persona (atom :designer)
                        panel/ref:current-page-id (atom nil)}
       (let [html (render (mf/element panel/audit-panel* #js {}))]
         (t/is (str/includes? html "ai-audit-panel"))
         (t/is (str/includes? html "Low contrast"))
         (t/is (str/includes? html "penforge.audit.fix-all")))))))

(t/deftest finding-texts-translate-codes-and-keep-ai-texts
  (let [contrast (assoc finding-contrast
                        :code "contrast"
                        :params {:label "\"Hint\"" :ratio 1.9 :background "#FFFFFF"
                                 :required 4.5 :color "#767676"})
        ai       {:code "ai-review" :params {:category "hierarchy"}
                  :title "Weak heading" :message "m" :suggestion "s"}]
    (t/is (= ["penforge.audit.contrast.title"
              "penforge.audit.contrast.message"
              "penforge.audit.contrast.suggestion"]
             (mapv #(first (str/split % #" ")) (panel/finding-texts contrast))))
    (t/is (= ["Weak heading" "m" "s"] (panel/finding-texts ai)))
    (t/is (= ["Low contrast" (:message finding-contrast) (:suggestion finding-contrast)]
             (panel/finding-texts finding-contrast)))))

(t/deftest content-labels-ai-findings-and-unchecked-contrast
  (let [ai   {:id "ai-review:hierarchy:text-title" :check "ai-review" :code "ai-review"
              :params {:category "hierarchy"} :severity "info" :node-id "text-title"
              :node-name "Title" :board-name "Login" :title "Weak heading"
              :message "The heading does not stand out." :suggestion "Make it bolder."}
        html (render (mf/element panel/audit-content*
                                 #js {:audit {:status :done
                                              :result (assoc result
                                                             :findings [ai]
                                                             :contrast-unchecked 2)}
                                      :persona :designer
                                      :onSelect identity
                                      :onAiChange identity}))]
    (t/is (str/includes? html "Weak heading"))
    (t/is (str/includes? html "penforge.audit.ai-badge"))
    (t/is (str/includes? html "penforge.audit.contrast-unchecked"))))
