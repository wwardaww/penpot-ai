;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-redesigned-apps-test
  "Re-Designed Existing projects in the Apps section (W39): app ids,
  requests naming the app, and the card."
  (:require
   ["react-dom/server" :as rds]
   [app.main.data.ai.apps :as apps]
   [app.main.data.ai.client :as client]
   [app.main.data.ai.protocol :as proto]
   [app.main.ui.dashboard.penforge.apps.card :as card]
   [app.main.ui.dashboard.penforge.apps.page :as page]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [potok.v2.core :as ptk]
   [rumext.v2 :as mf]))

(def ^:private project-id
  "a3de49e3-507f-8040-8008-fb2d0ea52a89")

(def ^:private landing-id
  (str project-id "~0a1b2c3d"))

(def ^:private landing
  {:app-id landing-id
   :project-id project-id
   :name "adissio landing"
   :project-name "Adissio"
   :file-name "adissio landing"
   :team-id "a3de49e3-507f-8040-8008-fb2cd62f76d4"
   :file-id "a3de49e3-507f-8040-8008-fb2d12ed0541"
   :platform "web"
   :stack {:name "next" :version "15.2.0"}
   :expo false
   :web true
   :built-at nil
   :commit nil
   :checkpoint nil
   :thumbnail nil
   :thumbnail-path nil
   :path "C:/Users/me/Penforge/projects/a3de49e3"
   :app-path "F:/adissio/landing"
   :redesign {:branch "penforge/redesign-20261122-0142"
              :base-branch "ai"
              :current-branch "penforge/redesign-20261122-0142"
              :root "F:/adissio"
              :app-dir "landing"
              :installed true
              :runnable true
              :source "changes"
              :updated-at "2026-11-21T22:42:18.266Z"}
   :status {:state "stopped"}})

(def ^:private built
  "A built app from a daemon before W39: no app id."
  {:project-id "p-web"
   :name "Shop"
   :platform "web"
   :stack {:name "React + Vite" :version "react 19"}
   :expo false
   :web true
   :built-at "2026-11-19T10:00:00.000Z"
   :path "C:/p-web"
   :app-path "C:/p-web/app-src"
   :status {:state "stopped"}})

(defn- listed
  []
  (-> {}
      (assoc-in [:penforge :apps :rid] "r1")
      (apps/apply-message {:type "apps.list" :rid "r1" :apps [landing built]})))

(defn- render
  [component props]
  (let [js-props #js {}]
    (doseq [[k v] props]
      (unchecked-set js-props (str/camel (name k)) v))
    (rds/renderToStaticMarkup (mf/element component js-props))))

(t/deftest apps-are-keyed-by-their-app-id
  (let [state (listed)
        items (get-in state [:penforge :apps :items])]
    (t/is (= [landing-id "p-web"] (get-in state [:penforge :apps :order]))
          "a built app without an app id keeps its project id")
    (t/is (= "adissio landing" (get-in items [landing-id :name])))
    (t/is (apps/redesigned? (get items landing-id)))
    (t/is (not (apps/redesigned? (get items "p-web"))))
    (let [state (apps/apply-message state {:type "apps.status" :project-id project-id
                                           :app-id landing-id :state "ready"
                                           :url "http://localhost:5200/"})]
      (t/is (= "ready" (get-in state [:penforge :apps :items landing-id :status :state])))
      (t/is (= "stopped" (get-in state [:penforge :apps :items "p-web" :status :state]))))
    (let [state (apps/apply-message state {:type "apps.status" :project-id "p-web"
                                           :state "ready" :url "http://localhost:5201/"})]
      (t/is (= "ready" (get-in state [:penforge :apps :items "p-web" :status :state]))
            "statuses without an app id reach the built app"))))

(t/deftest requests-name-the-project-and-the-app
  (let [sent  (atom [])
        state (assoc-in (listed) [:penforge :apps :rid] "r1")]
    (with-redefs [client/send! (fn [message] (swap! sent conj message) true)]
      (ptk/update (apps/start-app landing-id) state)
      (ptk/update (apps/stop-app landing-id) state)
      (ptk/update (apps/fetch-logs "p-web") state)
      (ptk/update (apps/stop-phone landing-id) state))
    (t/is (= [["apps.start" project-id landing-id]
              ["apps.stop" project-id landing-id]
              ["apps.logs" "p-web" "p-web"]
              ["apps.phone.stop" project-id landing-id]]
             (mapv (juxt :type :project-id :app-id) @sent)))
    (t/is (every? proto/valid-client-message? @sent))))

(t/deftest refusals-keep-their-reason
  (let [state (-> (listed)
                  (assoc-in [:penforge :apps :rids "s1"] [:start landing-id]))
        state (apps/apply-message state {:type "error" :rid "s1" :code "not-configured"
                                         :reason "not-installed" :message "x"})]
    (t/is (= {:code "not-configured" :reason "not-installed" :message "x"}
             (get-in state [:penforge :apps :errors landing-id])))))

(t/deftest the-protocol-carries-app-ids
  (t/is (some? (proto/decode (str "{\"type\":\"apps.status\",\"projectId\":\"p\",\"appId\":\"p~0a1b2c3d\","
                                  "\"state\":\"stopped\"}"))))
  (t/is (= "p~0a1b2c3d"
           (:app-id (proto/decode "{\"type\":\"apps.logs\",\"rid\":\"r\",\"projectId\":\"p\",\"appId\":\"p~0a1b2c3d\",\"lines\":[]}"))))
  (t/is (proto/valid-client-message? {:type "apps.phone.start" :rid "r" :project-id "p"
                                      :app-id "p~0a1b2c3d" :confirmed true}))
  (t/is (str/includes? (proto/encode {:type "apps.start" :rid "r" :project-id "p" :app-id "p~0a1b2c3d"})
                       "\"appId\":\"p~0a1b2c3d\"")))

(t/deftest the-redesigned-card-shows-project-badge-and-branch
  (let [markup (render card/app-card* {:app landing :developer false :connected true})]
    (t/is (str/includes? markup "adissio landing"))
    (t/is (str/includes? markup "penforge.apps.project"))
    (t/is (str/includes? markup "penforge.apps.redesign.badge"))
    (t/is (str/includes? markup "penforge/redesign-20261122-0142"))
    (t/is (str/includes? markup "next 15.2.0"))
    (t/is (str/includes? markup "penforge.apps.redesign.at"))
    (t/is (not (str/includes? markup "penforge.apps.built")))
    (t/is (str/includes? markup "penforge.apps.action.open"))
    (t/is (str/includes? markup "penforge.apps.action.design"))
    (t/is (not (str/includes? markup "penforge.apps.redesign.off-branch")))
    (t/is (not (str/includes? markup "disabled")) "Open is enabled")))

(t/deftest the-redesigned-card-says-why-it-cannot-start
  (let [missing  (render card/app-card* {:app (assoc-in landing [:redesign :installed] false)
                                         :developer false :connected true})
        no-dev   (render card/app-card* {:app (assoc-in landing [:redesign :runnable] false)
                                         :developer false :connected true})
        other    (render card/app-card* {:app (assoc-in landing [:redesign :current-branch] "ai")
                                         :developer false :connected true})
        detached (render card/app-card* {:app (assoc-in landing [:redesign :current-branch] nil)
                                         :developer false :connected true})
        refused  (render card/app-card* {:app landing :developer false :connected true
                                         :error {:code "not-configured" :reason "not-installed"}})]
    (t/is (str/includes? missing "penforge.apps.redesign.not-installed"))
    (t/is (str/includes? missing "disabled") "Open waits for the install")
    (t/is (str/includes? no-dev "penforge.apps.redesign.not-runnable"))
    (t/is (str/includes? other "penforge.apps.redesign.off-branch"))
    (t/is (str/includes? detached "penforge.apps.redesign.detached"))
    (t/is (str/includes? refused "penforge.apps.redesign.not-installed"))))

(t/deftest a-built-card-has-no-redesign-details
  (let [markup (render card/app-card* {:app built :developer false :connected true})]
    (t/is (not (str/includes? markup "penforge.apps.redesign")))
    (t/is (not (str/includes? markup "penforge.apps.project")) "the name is the project")
    (t/is (str/includes? markup "React + Vite"))
    (t/is (not (str/includes? markup "react 19")))))

(t/deftest the-grid-lists-both-kinds
  (let [grid (render page/apps-grid* {:apps-state (get-in (listed) [:penforge :apps])
                                      :developer false :connected true})]
    (t/is (= 2 (count (re-seq #"penforge-app-card" grid))))
    (t/is (str/includes? grid "adissio landing"))
    (t/is (str/includes? grid "Shop"))))
