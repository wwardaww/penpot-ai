;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.ai-apps-test
  (:require
   ["react-dom/server" :as rds]
   [app.main.data.ai.apps :as apps]
   [app.main.data.ai.protocol :as proto]
   [app.main.data.penforge :as pf]
   [app.main.store :as st]
   [app.main.ui.dashboard.penforge.apps.card :as card]
   [app.main.ui.dashboard.penforge.apps.nav :as nav]
   [app.main.ui.dashboard.penforge.apps.page :as page]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [rumext.v2 :as mf]))

(def ^:private web-app
  {:project-id "p-web"
   :name "Shop"
   :team-id "00000000-0000-0000-0000-000000000001"
   :file-id "00000000-0000-0000-0000-000000000002"
   :platform "web"
   :stack {:name "React + Vite" :version "react 19"}
   :expo false
   :web true
   :built-at "2026-11-19T10:00:00.000Z"
   :commit "abc"
   :checkpoint nil
   :thumbnail "data:image/png;base64,AAAA"
   :thumbnail-path ".penforge/thumbnail.png"
   :path "C:/Users/me/Penforge/projects/p-web"
   :app-path "C:/Users/me/Penforge/projects/p-web/app-src"
   :status {:state "stopped"}})

(def ^:private expo-app
  (assoc web-app
         :project-id "p-mobile"
         :name "Runner"
         :platform "mobile"
         :stack {:name "Expo" :version "54"}
         :expo true
         :web false
         :thumbnail nil
         :status {:state "stopped"}))

(defn- listed
  []
  (-> {}
      (assoc-in [:penforge :apps :rid] "r1")
      (apps/apply-message {:type "apps.list" :rid "r1" :apps [web-app expo-app {:bogus true}]})))

(defn- render
  "Render a component to markup; props become camelCase JS props with
  their values as they are (app maps stay CLJS maps)."
  [component props]
  (let [js-props #js {}]
    (doseq [[k v] props]
      (unchecked-set js-props (str/camel (name k)) v))
    (rds/renderToStaticMarkup (mf/element component js-props))))

(t/deftest the-list-reply-fills-the-state
  (let [state (listed)
        apps  (get-in state [:penforge :apps])]
    (t/is (= :loaded (:status apps)))
    (t/is (= ["p-web" "p-mobile"] (:order apps)) "invalid entries are dropped")
    (t/is (= "Shop" (get-in apps [:items "p-web" :name])))
    (t/is (= state (apps/apply-message state {:type "apps.list" :rid "other" :apps []}))
          "replies to an older request are ignored")))

(t/deftest status-messages-update-the-app
  (let [state (-> (listed)
                  (update-in [:penforge :apps :pending] (fnil conj #{}) "p-web")
                  (assoc-in [:penforge :apps :errors "p-web"] {:code "internal"})
                  (apps/apply-message {:type "apps.status" :project-id "p-web" :state "ready"
                                       :url "http://localhost:5200/" :exposure "loopback"}))
        app   (get-in state [:penforge :apps :items "p-web"])]
    (t/is (= "ready" (get-in app [:status :state])))
    (t/is (apps/live? app))
    (t/is (= "http://localhost:5200/" (apps/ready-url app)))
    (t/is (not (contains? (get-in state [:penforge :apps :pending]) "p-web")))
    (t/is (nil? (get-in state [:penforge :apps :errors "p-web"])))
    (t/is (= state (apps/apply-message state {:type "chat.delta" :conversation-id "c"}))
          "other messages leave the state alone")))

(t/deftest only-loopback-urls-are-opened
  (t/is (apps/safe-app-url? "http://localhost:5200/"))
  (t/is (apps/safe-app-url? "http://127.0.0.1:5299"))
  (t/is (apps/safe-app-url? "http://[::1]:5201/"))
  (t/is (not (apps/safe-app-url? "https://evil.example/")))
  (t/is (not (apps/safe-app-url? "javascript:alert(1)")))
  (t/is (not (apps/safe-app-url? "http://localhost.evil.example:5200/")))
  (t/is (nil? (apps/ready-url (assoc web-app :status {:state "ready" :url "http://192.168.1.2:5200/"})))))

(t/deftest errors-of-requests-land-where-they-belong
  (let [state (-> (listed)
                  (assoc-in [:penforge :apps :rids] {"s1" [:start "p-web"]
                                                     "ph" [:phone "p-mobile"]
                                                     "lg" [:logs "p-web"]
                                                     "ls" [:list nil]})
                  (update-in [:penforge :apps :pending] (fnil conj #{}) "p-web"))
        start (apps/apply-message state {:type "error" :rid "s1" :code "not-configured" :message "x"})
        phone (apps/apply-message state {:type "error" :rid "ph" :code "bad-request" :message "x"})
        logs  (apps/apply-message state {:type "error" :rid "lg" :code "internal" :message "x"})
        lst   (apps/apply-message state {:type "error" :rid "ls" :code "not-configured" :message "x"})]
    (t/is (= "not-configured" (get-in start [:penforge :apps :errors "p-web" :code])))
    (t/is (not (contains? (get-in start [:penforge :apps :pending]) "p-web")))
    (t/is (= "failed" (get-in phone [:penforge :apps :phone "p-mobile" :state])))
    (t/is (= [] (get-in logs [:penforge :apps :logs "p-web" :lines])))
    (t/is (= :failed (get-in lst [:penforge :apps :status])))
    (t/is (= state (apps/apply-message state {:type "error" :rid "unknown" :code "internal" :message "x"})))))

(t/deftest phone-and-log-messages-are-stored
  (let [state (-> (listed)
                  (apps/apply-message {:type "apps.phone" :project-id "p-mobile" :state "ready"
                                       :url "exp://192.168.1.2:5200" :qr {:size 2 :rows ["10" "01"]}})
                  (apps/apply-message {:type "apps.logs" :rid "x" :project-id "p-web"
                                       :lines [{:stream "stdout" :text "Local: http://localhost:5200/"}]}))]
    (t/is (= "exp://192.168.1.2:5200" (get-in state [:penforge :apps :phone "p-mobile" :url])))
    (t/is (= 1 (count (get-in state [:penforge :apps :logs "p-web" :lines]))))))

(t/deftest the-protocol-accepts-the-apps-messages
  (t/is (some? (proto/decode "{\"type\":\"apps.list\",\"rid\":\"r\",\"apps\":[]}")))
  (t/is (some? (proto/decode "{\"type\":\"apps.status\",\"projectId\":\"p\",\"state\":\"ready\",\"url\":\"http://localhost:5200/\",\"exposure\":\"loopback\"}")))
  (t/is (some? (proto/decode "{\"type\":\"apps.phone\",\"projectId\":\"p\",\"state\":\"ready\",\"qr\":{\"size\":1,\"rows\":[\"1\"]}}")))
  (t/is (some? (proto/decode "{\"type\":\"apps.logs\",\"rid\":\"r\",\"projectId\":\"p\",\"lines\":[]}")))
  (t/is (proto/valid-client-message? {:type "apps.phone.start" :rid "r" :project-id "p" :confirmed true}))
  (t/is (not (proto/valid-client-message? {:type "apps.phone.start" :rid "r" :project-id "p" :confirmed false})))
  (t/is (proto/valid-client-message? {:type "apps.list" :rid "r" :team-id "t"})))

(t/deftest the-cards-render
  (let [web      (render card/app-card* {:app web-app :developer false :connected true})
        running  (render card/app-card* {:app (assoc web-app :status {:state "ready" :url "http://localhost:5200/"})
                                         :developer true :connected true
                                         :logs {:lines [{:stream "stderr" :text "warn"}]}})
        failed   (render card/app-card* {:app (assoc web-app :status {:state "failed" :reason "crashed"})
                                         :developer false :connected true
                                         :error {:code "not-connected"}})
        mobile   (render card/app-card* {:app expo-app :developer false :connected true})
        consent  (render card/app-card* {:app expo-app :developer false :connected true :phone {}})
        phone    (render card/app-card* {:app expo-app :developer true :connected true
                                         :phone {:state "ready" :url "exp://192.168.1.2:5200"
                                                 :qr {:size 2 :rows ["10" "01"]}}})]
    (t/is (str/includes? web "penforge.apps.action.open"))
    (t/is (str/includes? web "data:image/png;base64,AAAA"))
    (t/is (str/includes? web "penforge.apps.action.design"))
    (t/is (not (str/includes? web "penforge.apps.action.logs")) "designers see no logs")
    (t/is (not (str/includes? web "penforge.apps.action.stop")))
    (t/is (str/includes? running "penforge.apps.action.stop"))
    (t/is (str/includes? running "penforge.apps.state.running"))
    (t/is (str/includes? running "penforge.apps.action.folder"))
    (t/is (str/includes? running "warn"))
    (t/is (str/includes? failed "penforge.preview.reason.crashed"))
    (t/is (str/includes? failed "penforge.apps.error.not-connected"))
    (t/is (str/includes? mobile "penforge.apps.mobile-hint"))
    (t/is (not (str/includes? mobile "penforge.apps.action.open")) "Expo without web has no browser Open")
    (t/is (str/includes? mobile "penforge.publish.phone.title"))
    (t/is (str/includes? consent "penforge.publish.phone.confirm") "LAN only after the user agrees")
    (t/is (str/includes? phone "<svg"))
    (t/is (str/includes? phone "exp://192.168.1.2:5200"))))

(t/deftest the-grid-states-render
  (let [loading (render page/apps-grid* {:apps-state {:status :loading} :developer false :connected true})
        empty   (render page/apps-grid* {:apps-state {:status :loaded :order []} :developer false :connected true})
        failed  (render page/apps-grid* {:apps-state {:status :failed :error {:code "not-configured"}}
                                         :developer false :connected true})
        grid    (render page/apps-grid* {:apps-state (get-in (listed) [:penforge :apps])
                                         :developer false :connected true})]
    (t/is (str/includes? loading "penforge.apps.loading"))
    (t/is (str/includes? empty "penforge.apps.empty.title"))
    (t/is (str/includes? failed "penforge.apps.error.unavailable"))
    (t/is (= 2 (count (re-seq #"penforge-app-card" grid))))))

(t/deftest the-page-shows-the-connection-help-or-the-grid
  (let [previous @st/state]
    (try
      (swap! st/state assoc :penforge {:connection {:status :disconnected :reason :unreachable}})
      (let [down (render page/apps-page* {:team {:id "t"}})]
        (t/is (str/includes? down "penforge.chat.status.unreachable"))
        (t/is (not (str/includes? down "penforge-apps-grid"))))
      (swap! st/state assoc :penforge {:connection {:status :disconnected :reason :auth-error}})
      (let [unpaired (render page/apps-page* {:team {:id "t"}})]
        (t/is (str/includes? unpaired "penforge.chat.status.pair-expired"))
        (t/is (str/includes? unpaired "penforge.chat.pair.label") "the pairing field is shown"))
      (swap! st/state assoc :penforge {:connection {:status :connected}
                                       :apps (get-in (listed) [:penforge :apps])})
      (let [connected (render page/apps-page* {:team {:id "t"}})]
        (t/is (str/includes? connected "penforge-apps-grid")))
      (finally
        (reset! st/state previous)))))

(t/deftest the-sidebar-entry-renders-with-the-flag
  (with-redefs [pf/enabled? (constantly true)]
    (let [markup (render nav/apps-nav-item* {:current-section :dashboard-apps
                                             :team-id "t"
                                             :classes {:item "item" :current "current"
                                                       :link "link" :title "title"}})]
      (t/is (str/includes? markup "penforge.apps.title"))
      (t/is (str/includes? markup "item current"))))
  (with-redefs [pf/enabled? (constantly false)]
    (t/is (= "" (render nav/apps-nav-item* {:current-section :dashboard-recent :team-id "t" :classes {}})))))
