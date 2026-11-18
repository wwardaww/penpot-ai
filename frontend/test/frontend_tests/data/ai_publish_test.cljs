;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-publish-test
  (:require
   ["jsdom" :refer [JSDOM]]
   ["react-dom/server" :as rds]
   [app.main.data.ai.actions :as actions]
   [app.main.data.ai.actions.all]
   [app.main.data.ai.actions.publish :as dap]
   [app.main.store :as st]
   [app.main.ui.workspace.ai.publish.share :as share]
   [app.util.globals :as globals]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [frontend-tests.helpers.mock :as mock]
   [rumext.v2 :as mf]))

(def ^:private status-result
  {:action "status"
   :accounts [{:provider "github" :login "octo" :saved-at "2026-11-18T10:00:00.000Z"}]
   :app {:exists true :phone true}
   :published {:vercel {:url "https://shop.vercel.app" :site-id "prj_1" :site-name "shop"
                        :deployed-at "2026-11-18T10:00:00.000Z"}}
   :requested "github"})

(defn- reduce-run
  [state action messages]
  (reduce #(dap/apply-run-message %1 action %2) state messages))

(defn- loaded-state
  []
  (reduce-run dap/empty-state :status
              [{:type "workflow.event" :run-id "r1" :kind "result" :payload status-result}
               {:type "workflow.done" :run-id "r1" :ok true}]))

(t/deftest status-results-fill-the-state
  (let [state (reduce-run dap/empty-state :status
                          [{:type "workflow.started" :run-id "r1"}
                           {:type "workflow.event" :run-id "r1" :kind "result" :payload status-result}
                           {:type "workflow.done" :run-id "r1" :ok true}])]
    (t/is (= :loaded (:status state)))
    (t/is (= {:login "octo" :saved-at "2026-11-18T10:00:00.000Z"} (dap/connected-account state :github)))
    (t/is (nil? (dap/connected-account state :vercel)))
    (t/is (= :github (:target state)) "the chat's request selects the section")
    (t/is (= "https://shop.vercel.app" (get-in state [:published :vercel :url])))
    (t/is (not (dap/busy? state)))))

(t/deftest runs-track-progress-results-and-failures
  (let [running (reduce-run dap/empty-state :vercel
                            [{:type "workflow.started" :run-id "r2"}
                             {:type "workflow.event" :run-id "r2" :kind "progress" :payload {:step "build"}}])
        failed  (reduce-run running :vercel
                            [{:type "workflow.event" :run-id "r2" :kind "failed"
                              :payload {:code "build-failed" :params {} :message "npm run build failed"}}
                             {:type "workflow.done" :run-id "r2" :ok false :error "npm run build failed"}])
        dropped (reduce-run running :vercel [{:type "error" :code "not-connected-daemon"}])]
    (t/is (dap/busy? running :vercel))
    (t/is (= "build" (get-in running [:progress :vercel :step])))
    (t/is (not (dap/busy? failed :vercel)))
    (t/is (= "build-failed" (get-in failed [:errors :vercel :code])) "the daemon's failure wins")
    (t/is (= "penforge.publish.error.build-failed" (dap/error-text (get-in failed [:errors :vercel]))))
    (t/is (= "not-connected-daemon" (get-in dropped [:errors :vercel :code])))
    (t/is (not (dap/busy? dropped)))))

(t/deftest accounts-change-with-connect-and-disconnect
  (let [connected (reduce-run dap/empty-state :connect
                              [{:type "workflow.started" :run-id "c1"}
                               {:type "workflow.event" :run-id "c1" :kind "result"
                                :payload {:action "connect"
                                          :account {:provider "netlify" :login "me@x.io" :saved-at "t"}}}
                               {:type "workflow.done" :run-id "c1" :ok true}])
        removed   (reduce-run connected :disconnect
                              [{:type "workflow.event" :run-id "d1" :kind "result"
                                :payload {:action "disconnect" :provider "netlify" :removed true}}])]
    (t/is (= "me@x.io" (:login (dap/connected-account connected :netlify))))
    (t/is (nil? (dap/connected-account removed :netlify)))
    (t/is (not (str/includes? (pr-str connected) "token")) "no token is kept")))

(t/deftest the-phone-session-ends-with-its-run
  (let [qr    {:size 2 :rows ["10" "01"]}
        ready (reduce-run dap/empty-state :phone
                          [{:type "workflow.started" :run-id "p1"}
                           {:type "workflow.event" :run-id "p1" :kind "phone"
                            :payload {:state "ready" :url "exp://192.168.1.5:5200" :qr qr}}])
        done  (reduce-run ready :phone [{:type "workflow.done" :run-id "p1" :ok false :error "cancelled"}])]
    (t/is (= "exp://192.168.1.5:5200" (get-in ready [:phone :url])))
    (t/is (nil? (:phone done)))
    (t/is (nil? (get-in done [:errors :phone])) "stopping is no failure")
    (t/is (= "M0 0h1v1h-1zM1 1h1v1h-1z" (share/qr-path (:rows qr))))))

(t/deftest the-chat-tool-call-is-recognized
  (t/is (dap/open-publish-call? {:type "chat.tool" :tool-name "mcp__penpot__penforge_open_publish" :status "done"}))
  (t/is (not (dap/open-publish-call? {:type "chat.tool" :tool-name "mcp__penpot__penforge_open_publish"
                                      :status "running"})))
  (t/is (not (dap/open-publish-call? {:type "chat.tool" :tool-name "mcp__penpot__list_boards" :status "done"}))))

(t/deftest the-share-action-is-registered
  (let [registry @actions/registry
        state    {:penforge {:connection {:status :connected}}}]
    (t/is (some #(= :ai/share (:id %)) (actions/get-actions registry :header state)))
    (t/is (some #(= :ai/accounts (:id %)) (actions/get-actions registry :main-menu state)))))

(t/deftest the-sections-render
  (let [state   (loaded-state)
        site    (fn [publish provider]
                  (rds/renderToStaticMarkup
                   (mf/element share/site-section*
                               #js {:publish publish :developer false :connected true :provider provider})))
        zip     (rds/renderToStaticMarkup
                 (mf/element share/zip-section* #js {:publish state :developer false :connected true}))
        github  (rds/renderToStaticMarkup
                 (mf/element share/github-section* #js {:publish state :developer false :connected true}))
        phone   (rds/renderToStaticMarkup
                 (mf/element share/phone-section*
                             #js {:publish (assoc state :phone {:state "ready"
                                                                :url "exp://1.2.3.4:5200"
                                                                :qr {:size 2 :rows ["10" "01"]}})
                                  :developer true
                                  :connected true}))
        running (site (reduce-run (assoc-in state [:accounts :vercel] {:login "octo-v"}) :vercel
                                  [{:type "workflow.started" :run-id "x"}
                                   {:type "workflow.event" :run-id "x" :kind "progress"
                                    :payload {:step "upload"}}])
                      :vercel)]
    (t/is (str/includes? zip "penforge.publish.zip.action"))
    (t/is (str/includes? github "penforge.publish.connected-as"))
    (t/is (str/includes? github "penforge.publish.github.private"))
    (t/is (str/includes? (site state :vercel) "https://shop.vercel.app"))
    (t/is (str/includes? (site state :netlify) "penforge.publish.needs-account"))
    (t/is (str/includes? phone "<svg"))
    (t/is (str/includes? phone "exp://1.2.3.4:5200"))
    (t/is (str/includes? running "penforge.publish.step.upload"))))

(t/deftest ^:async the-dialog-and-accounts-render
  ;; Icon buttons need a document for their tooltips. Only the dialog
  ;; shell is checked through the store (other test namespaces replace
  ;; st/state); the accounts panel gets its state as a prop.
  (let [window   (.-window (JSDOM. "<!doctype html><html><body></body></html>"))
        document (.-document window)
        previous @st/state]
    (try
      (await
       (mock/with-mocks* {globals/document document globals/window window}
         (swap! st/state assoc :penforge {:connection {:status :connected}
                                          :publish (loaded-state)})
         (let [dialog   (rds/renderToStaticMarkup (mf/element share/share-dialog* #js {}))
               state    (assoc (loaded-state)
                               :errors {:connect {:code "token-invalid" :params {:provider "Vercel"}}}
                               :connecting :vercel)
               accounts (rds/renderToStaticMarkup
                         (mf/element share/accounts-panel* #js {:publish state :developer false :connected true}))]
           (t/is (str/includes? dialog "ai-share-dialog"))
           (t/is (str/includes? dialog "penforge.publish.title"))
           (t/is (str/includes? accounts "type=\"password\""))
           (t/is (str/includes? accounts "penforge.publish.error.token-invalid"))
           (t/is (str/includes? accounts "penforge.publish.accounts.disconnect")))))
      (finally
        (reset! st/state previous)
        (.close window)))))
