;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.ai-build-changes-test
  "Change requests and the Update button (W34): the change list state,
  the Build/Update/Up to date button, the instructions for the AI, the
  dialog's change list and question, and the read-only background runs
  (jsdom documents, the runner has no DOM)."
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom" :as rd]
   ["react-dom/client" :as rdc]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.build :as build-action]
   [app.main.data.ai.chat :as chat]
   [app.main.ui.workspace.ai.build.dialog :as dialog]
   [app.main.ui.workspace.ai.build.events :as build]
   [app.main.ui.workspace.ai.header-strip :as header-strip]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private change-set
  {:screens [{:board-id "b-login" :name "Login" :status "changed"
              :items [{:code "text-changed"
                       :params {:layer "Title" :before "Sign in" :after "Log in"}
                       :text "Text of \"Title\" changed from \"Sign in\" to \"Log in\""}]
              :more 0}
             {:board-id "b-dash" :name "Home" :status "changed" :previous-name "Dashboard"
              :items [{:code "layer-added" :params {:layer "Footer"} :text "Added \"Footer\""}
                      {:code "brand-new-code" :params {} :text "Something the client does not know"}]
              :more 2}]
   :tokens [{:code "token-changed"
             :params {:name "color.primary" :before "#6c5ce7" :after "#e17055"}
             :text "Token \"color.primary\" changed from #6c5ce7 to #e17055"}]
   :flows []
   :design-system nil
   :count 3
   :token-only false
   :baseline "state"})

(def ^:private changes-result
  {:has-build true
   :busy false
   :last-build {:n 1 :label "build 1" :at "2026-11-21T10:00:00Z"}
   :count 3
   :token-only false
   :changes change-set
   :kept-instructions "- Play a piece sound on every move"})

(defn- with-changes
  [changes]
  {:penforge {:build-changes changes
              :build build/initial-state}})

;; --- Change list state and the button

(t/deftest change-list-result-is-stored
  (let [changes (build/apply-changes-message
                 {:status :checking}
                 {:type "workflow.event" :kind "result" :payload changes-result})]
    (t/is (= :ready (:status changes)))
    (t/is (= 3 (build/get-change-count changes)))
    (t/is (= "- Play a piece sound on every move" (:kept-instructions changes)))
    (t/is (= :update (build/get-cta changes))))
  (t/testing "a busy answer keeps the last list"
    (let [known (build/apply-changes-result {:status :checking :has-build true :count 2}
                                            {:busy true :has-build true :count 0})]
      (t/is (= 2 (:count known)))
      (t/is (= :ready (:status known)))))
  (t/testing "a failed check keeps the last list"
    (let [failed (build/apply-changes-message {:status :checking :has-build true :count 2}
                                              {:type "workflow.done" :ok false})]
      (t/is (= :error (:status failed)))
      (t/is (= :update (build/get-cta failed))))))

(t/deftest button-is-build-then-update-then-up-to-date
  (t/is (= :build (build/get-cta {:status :idle})) "unknown: Build")
  (t/is (= :build (build/get-cta {:status :ready :has-build false :count 0})))
  (t/is (= :up-to-date (build/get-cta {:status :ready :has-build true :count 0})))
  (t/is (= :update (build/get-cta {:status :ready :has-build true :count 2})))
  (t/is (= :update (build/get-cta {:status :checking :has-build true})) "count not known yet")
  (let [up-to-date (with-changes {:status :ready :has-build true :count 0})
        changed    (with-changes {:status :ready :has-build true :count 2})
        first-app  (with-changes {:status :ready :has-build false :count 0})]
    (t/is (false? (build-action/build-enabled? up-to-date)) "Up to date is disabled")
    (t/is (true? (build-action/build-enabled? changed)))
    (t/is (true? (build-action/build-enabled? first-app)))
    (t/is (= "2" (build-action/get-build-badge changed)))
    (t/is (nil? (build-action/get-build-badge up-to-date)))
    (t/is (nil? (build-action/get-build-badge first-app)))
    (t/is (= "penforge.build.update" (build-action/get-build-label changed)))
    (t/is (= "penforge.build.up-to-date" (build-action/get-build-label up-to-date)))
    (t/is (= "penforge.build" (build-action/get-build-label first-app)))))

(t/deftest island-items-carry-label-and-badge
  (let [registry {:test/cta {:id :test/cta
                             :label (constantly "Update")
                             :badge (fn [state] (str (:n state)))
                             :scopes #{:island}
                             :primary true
                             :run identity}}
        [item] (header-strip/scope-items registry :island {:n 3})
        [later] (header-strip/scope-items registry :island {:n 4})]
    (t/is (= "Update" (:label item)))
    (t/is (= "3" (:badge item)))
    (t/is (not= item later) "a new count renders again")))

(t/deftest instructions-only-update-action-follows-the-build-button
  (let [action (get @actions/registry :ai/build-instructions)]
    (t/is (some? action))
    (t/is (not ((:visible? action) (with-changes {:status :ready :has-build false}))))
    (t/is ((:visible? action) (with-changes {:status :ready :has-build true :count 0}))
          "shown when the app is up to date, so instructions can go in")))

(t/deftest instructions-are-sent-as-build-run-takes-them
  (t/is (nil? (build/get-instructions {:text "  " :keep true :kept nil :kept-original ""})))
  (t/is (= {:text "Play a sound" :keep true}
           (build/get-instructions {:text " Play a sound " :keep true
                                    :kept "- Old" :kept-original "- Old"}))
        "kept instructions are sent only when edited")
  (t/is (= {:kept ""}
           (build/get-instructions {:text "" :keep true :kept "" :kept-original "- Old"}))
        "emptied kept instructions remove them")
  (t/is (= {:text "Save games locally"}
           (build/get-instructions {:text "Save games locally" :keep false}))))

(t/deftest background-checks-do-not-count-as-ai-work
  (let [chat {:status :idle
              :pending-runs {}
              :runs {"r1" {:run-id "r1" :status :running :silent true :read-only true}}}]
    (t/is (false? (chat/busy? chat)))
    (t/is (true? (chat/busy? (assoc-in chat [:runs "r2"] {:run-id "r2" :status :running :silent true}))))
    (t/is (false? (chat/busy? (assoc chat :pending-runs {"rid" {:name "build-changes" :silent true :read-only true}}))))))

;; --- Dialog reducer

(t/deftest change-list-run-ends-on-the-review-stage
  (let [result (reduce build/apply-message
                       (assoc build/initial-state :stage :changes :workflow "build-changes")
                       [{:type "workflow.started" :run-id "r1"}
                        {:type "workflow.event" :run-id "r1" :kind "result" :payload changes-result}
                        {:type "workflow.done" :run-id "r1" :ok true}])]
    (t/is (= :review (:stage result)))
    (t/is (= changes-result (:result result)))))

(t/deftest a-build-question-is-kept-until-the-run-ends
  (let [question {:question-id "q1" :text "Some instructions don't fit the design"
                  :options [{:id "design" :label "Keep the design"}
                            {:id "instruction" :label "Follow my instructions"}]}
        asked    (build/apply-message (assoc build/initial-state :stage :building :workflow "build-run")
                                      {:type "workflow.event" :run-id "r1" :kind "question" :payload question})]
    (t/is (= question (:question asked)))
    (t/is (nil? (:question (build/apply-message asked {:type "workflow.done" :ok true}))))))

;; --- Render

(defn- next-immediate
  []
  (js/Promise. (fn [resolve] (js/setImmediate resolve))))

(defn- ^:async render-view
  "Renders `build-view*` once; resolves to `{:markup :errors}`."
  [props]
  (let [errors    (volatile! [])
        on-error  (fn [error _info] (vswap! errors conj (.-message error)))
        window    (.-window (JSDOM. "<!doctype html><div id=\"root\"></div>"))
        container (.getElementById (.-document window) "root")
        root      (rdc/createRoot container #js {:onUncaughtError on-error
                                                 :onCaughtError on-error
                                                 :onRecoverableError on-error})
        previous  (.-window js/globalThis)
        markup    (volatile! nil)]
    (set! (.-window js/globalThis) window)
    (try
      (try
        (rd/flushSync
         (fn []
           (.render root (mf/element dialog/build-view*
                                     #js {:build (:build props)
                                          :persona (:persona props)
                                          :keptInstructions (:kept-instructions props)}))))
        (vreset! markup (.-innerHTML container))
        (finally
          (rd/flushSync #(.unmount root))
          (.close window)))
      (await (next-immediate))
      (finally
        (set! (.-window js/globalThis) previous)))
    {:markup @markup :errors @errors}))

(defn- includes-all?
  [markup texts]
  (every? #(str/includes? markup %) texts))

(t/deftest change-items-are-translated-by-code
  (t/is (= "penforge.build.change.text-changed"
           (dialog/get-change-text (get-in change-set [:screens 0 :items 0]))))
  (t/is (= "Something the client does not know"
           (dialog/get-change-text (get-in change-set [:screens 1 :items 1])))
        "unknown codes fall back to the daemon's text"))

(t/deftest ^:async review-lists-the-changes-with-the-instruction-fields
  (let [{:keys [markup errors]}
        (await (render-view {:build {:stage :review :rid 7 :result changes-result}
                             :persona :designer
                             :kept-instructions "- Play a piece sound on every move"}))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["penforge-build-changes" "Login" "Home"
                                 "penforge.build.changes.intro"
                                 "penforge.build.change.text-changed"
                                 "penforge.build.change.layer-added"
                                 "Something the client does not know"
                                 "penforge.build.changes.more"
                                 "penforge.build.changes.tokens"
                                 "penforge.build.change.token-changed"
                                 "penforge-build-instructions"
                                 "penforge.build.instructions.keep"
                                 "penforge-build-kept-instructions"
                                 "- Play a piece sound on every move"
                                 "penforge.build.changes.confirm"]))))

(t/deftest ^:async nothing-changed-still-takes-instructions
  (let [{:keys [markup errors]}
        (await (render-view {:build {:stage :review :rid 8
                                     :result (assoc changes-result :count 0 :changes nil
                                                   :kept-instructions "")}
                             :persona :designer
                             :kept-instructions ""}))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["penforge.build.changes.none" "penforge-build-instructions"]))
    (t/is (not (str/includes? markup "penforge-build-kept-instructions")) "no kept instructions yet")
    (t/is (str/includes? markup "disabled") "Update waits for a change or an instruction")))

(t/deftest ^:async a-first-build-plan-takes-instructions
  (let [{:keys [markup errors]}
        (await (render-view {:build {:stage :plan
                                     :plan {:plan-id "p1" :mode "full" :summary "A chess app."
                                            :screens [{:board-id "b" :name "Board" :status "new"}]}}
                             :persona :designer
                             :kept-instructions ""}))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["penforge-build-instructions" "penforge.build.instructions.label"]))))

(t/deftest ^:async a-build-question-is-answered-in-the-dialog
  (let [{:keys [markup errors]}
        (await (render-view {:build {:stage :building :update true :steps []
                                     :question {:question-id "q1"
                                                :text "Some instructions don't fit the design"
                                                :options [{:id "design" :label "Keep the design"}
                                                          {:id "instruction" :label "Follow my instructions"}]}}
                             :persona :designer}))]
    (t/is (empty? errors))
    (t/is (includes-all? markup ["penforge.build.updating"
                                 "Some instructions don"
                                 "penforge.build.question.design"
                                 "penforge.build.question.instruction"]))))

(t/deftest ^:async update-done-names-assets-and-theme-only-updates
  (let [result   {:mode "incremental" :token-only true :change-request "CR-2"
                  :assets [{:file "src/sound.ts" :source "Web Audio API" :license "none needed"}]}
        designer (await (render-view {:build {:stage :done :update true :result result} :persona :designer}))
        dev      (await (render-view {:build {:stage :done :update true :result result} :persona :developer}))
        nothing  (await (render-view {:build {:stage :done :update true :result {:mode "none"}} :persona :designer}))]
    (t/is (empty? (concat (:errors designer) (:errors dev) (:errors nothing))))
    (t/is (includes-all? (:markup designer) ["penforge.build.done.updated" "penforge.build.done.tokens-only"
                                             "Web Audio API"]))
    (t/is (not (str/includes? (:markup designer) "src/sound.ts")) "designers see no file names")
    (t/is (includes-all? (:markup dev) ["src/sound.ts" "penforge.build.dev.change-request"]))
    (t/is (str/includes? (:markup nothing) "penforge.build.done.nothing"))
    (t/is (not (str/includes? (:markup nothing) "penforge.build.done.open-preview")))))
