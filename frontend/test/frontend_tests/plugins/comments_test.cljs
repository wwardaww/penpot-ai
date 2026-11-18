;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.plugins.comments-test
  (:require
   [app.common.geom.point :as gpt]
   [app.common.test-helpers.compositions :as tho]
   [app.common.test-helpers.files :as thf]
   [app.common.test-helpers.ids-map :as thi]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.comments :as dc]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.plugins.comments :as comments]
   [app.plugins.page :as page]
   [app.plugins.register :as r]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.mock :as mock]))

(def ^:private plugin-id "00000000-0000-0000-0000-000000000000")

(t/deftest comment-thread-remove-allows-the-owner
  (t/async done
    (let [owner-id  (random-uuid)
          file-id   (random-uuid)
          page-id   (random-uuid)
          thread-id (random-uuid)
          emitted   (atom nil)
          thread    (comments/comment-thread-proxy
                     plugin-id
                     file-id
                     page-id
                     {:id thread-id :owner-id owner-id})]
      (set! st/state (atom {:profile {:id owner-id}}))
      (mock/with-mocks
        {r/check-permission (constantly true)
         dc/delete-comment-thread-on-workspace
         (mock/stub (fn [params callback]
                      (callback)
                      [:delete-thread params]))
         st/emit! (mock/stub (fn [event] (reset! emitted event)))}
        (fn [done']
          (let [result (.remove thread)]
            (t/is (instance? js/Promise result))
            (t/is (= [:delete-thread {:id thread-id}] @emitted))
            (done')))
        done))))

(t/deftest page-remove-comment-thread-emits-delete-event
  (t/async done
    (let [file-id   (random-uuid)
          page-id   (random-uuid)
          thread-id (random-uuid)
          emitted   (atom nil)
          page      (page/page-proxy plugin-id file-id page-id)
          thread    (comments/comment-thread-proxy
                     plugin-id
                     file-id
                     page-id
                     {:id thread-id :owner-id (random-uuid)})]
      (mock/with-mocks
        {r/check-permission (constantly true)
         dc/delete-comment-thread-on-workspace
         (mock/stub (fn [params callback]
                      (callback)
                      [:delete-thread params]))
         st/emit! (mock/stub (fn [event] (reset! emitted event)))}
        (fn [done']
          (let [result (.removeCommentThread page thread)]
            (t/is (instance? js/Promise result))
            (t/is (= [:delete-thread {:id thread-id}] @emitted))
            (done')))
        done))))

;; --- Thread anchoring (nodeId)

(defn- sample-board-file
  "Page tree, bottom to top inside each parent:
     :board  frame   0,0 200x200
       :bottom rect  10,10 100x100
       :top    rect  50,50 100x100
       :group  group 150,10 40x40
         :in-group rect 150,10 10x10
       :inner  frame 10,150 20x20 (clips content)
         :wide rect 10,150 100x20
     :outside rect 500,500 50x50"
  []
  (-> (thf/sample-file :file)
      (tho/add-frame :board :x 0 :y 0 :width 200 :height 200)
      (tho/add-rect :bottom :parent-label :board :x 10 :y 10 :width 100 :height 100)
      (tho/add-rect :top :parent-label :board :x 50 :y 50 :width 100 :height 100)
      (tho/add-group :group :parent-label :board :x 150 :y 10 :width 40 :height 40)
      (tho/add-rect :in-group :parent-label :group :x 150 :y 10 :width 10 :height 10)
      (tho/add-frame :inner :parent-label :board :x 10 :y 150 :width 20 :height 20)
      (tho/add-rect :wide :parent-label :inner :x 10 :y 150 :width 100 :height 20)
      (tho/add-rect :outside :x 500 :y 500 :width 50 :height 50)))

(defn- page-objects
  [file]
  (:objects (thf/current-page file)))

(defn- node-at
  [objects frame-label x y]
  (comments/get-thread-node-id objects (thi/id frame-label) (gpt/point x y)))

(t/deftest thread-node-id-picks-the-top-most-shape
  (let [objects (page-objects (sample-board-file))]
    (t/is (= (thi/id :top) (node-at objects :board 60 60))
          "overlapping siblings resolve to the one painted last")
    (t/is (= (thi/id :bottom) (node-at objects :board 20 20)))
    (t/is (= (thi/id :board) (node-at objects :board 190 190))
          "the board itself when no child is under the point")))

(t/deftest thread-node-id-skips-hidden-shapes
  (let [objects (-> (page-objects (sample-board-file))
                    (assoc-in [(thi/id :top) :hidden] true))]
    (t/is (= (thi/id :bottom) (node-at objects :board 60 60)))))

(t/deftest thread-node-id-never-returns-groups
  (let [objects (page-objects (sample-board-file))]
    (t/is (= (thi/id :in-group) (node-at objects :board 155 15)))
    (t/is (= (thi/id :board) (node-at objects :board 185 45))
          "a point inside the group box but on no child falls to the board")))

(t/deftest thread-node-id-respects-clipping-boards
  (let [objects (page-objects (sample-board-file))]
    (t/is (= (thi/id :wide) (node-at objects :board 20 160)))
    (t/is (= (thi/id :board) (node-at objects :board 80 160))
          "the clipped part of a child is not hit")
    (t/is (= (thi/id :wide)
             (node-at (assoc-in objects [(thi/id :inner) :show-content] true) :board 80 160))
          "a board that shows its overflow lets the child be hit")))

(t/deftest thread-node-id-falls-back-to-the-page
  (let [objects (page-objects (sample-board-file))]
    (t/is (= (thi/id :outside)
             (comments/get-thread-node-id objects uuid/zero (gpt/point 520 520))))
    (t/is (= (thi/id :outside) (node-at objects :board 520 520))
          "a board that no longer holds the point is ignored")
    (t/is (= (thi/id :top)
             (comments/get-thread-node-id objects (random-uuid) {:x 60 :y 60}))
          "a deleted board falls back to the page; plain maps are accepted")
    (t/is (nil? (comments/get-thread-node-id objects uuid/zero (gpt/point 1000 1000))))))

;; --- Public ids

(t/deftest comment-thread-exposes-enumerable-ids
  (let [file      (sample-board-file)
        file-id   (:id file)
        page-id   (thf/current-page-id file)
        thread-id (random-uuid)
        thread    (comments/comment-thread-proxy
                   plugin-id file-id page-id
                   {:id thread-id
                    :page-id page-id
                    :frame-id (thi/id :board)
                    :position (gpt/point 60 60)})
        keys      (set (js/Object.keys thread))
        prev      st/state]
    (set! st/state (atom {:files {file-id {:data (:data file)}}}))
    (try
      (t/is (= (str thread-id) (.-id thread)))
      (t/is (= (str page-id) (.-pageId thread)))
      (t/is (= (str (thi/id :top)) (.-nodeId thread)))
      (t/is (contains? keys "id"))
      (t/is (contains? keys "pageId"))
      (t/is (contains? keys "nodeId"))
      (t/is (not (contains? keys "$id")))
      (finally
        (set! st/state prev)))))

(t/deftest comment-thread-node-id-is-null-without-page-data
  (let [prev   st/state
        thread (comments/comment-thread-proxy
                plugin-id (random-uuid) (random-uuid)
                {:id (random-uuid) :frame-id uuid/zero :position (gpt/point 1 1)})]
    (set! st/state (atom {}))
    (try
      (t/is (nil? (.-nodeId thread)))
      (finally
        (set! st/state prev)))))

(t/deftest comment-exposes-enumerable-id
  (let [comment-id (random-uuid)
        comment    (comments/comment-proxy
                    plugin-id (random-uuid) (random-uuid) (random-uuid)
                    {:id comment-id :content "hi"})]
    (t/is (= (str comment-id) (.-id comment)))
    (t/is (contains? (set (js/Object.keys comment)) "id"))))

;; --- Page queries

(defn- sample-threads
  [page-id other-page-id]
  [{:id (random-uuid) :seqn 1 :page-id page-id :is-resolved false}
   {:id (random-uuid) :seqn 2 :page-id page-id :is-resolved true}
   {:id (random-uuid) :seqn 3 :page-id other-page-id :is-resolved false}])

(defn- threads-rpc
  [calls threads]
  (mock/stub
   (fn [cmd params]
     (swap! calls conj [cmd params])
     (->> (rx/of threads)
          (rx/observe-on :async)))))

(defn- seq-numbers
  [threads]
  (mapv (fn [^js thread] (.-seqNumber thread)) threads))

(t/deftest ^:async page-find-comment-threads-filters-the-page
  (let [file-id       (random-uuid)
        page-id       (random-uuid)
        other-page-id (random-uuid)
        calls         (atom [])
        page          (page/page-proxy plugin-id file-id page-id)
        prev          st/state]
    (set! st/state (atom {:profile-id (random-uuid)}))
    (await
     (mock/with-mocks*
       {r/check-permission (constantly true)
        rp/cmd!            (threads-rpc calls (sample-threads page-id other-page-id))}
       (t/is (= [1] (seq-numbers (await (.findCommentThreads page))))
             "no criteria: unresolved threads of this page only")
       (t/is (= [1] (seq-numbers (await (.findCommentThreads page #js {:onlyYours false}))))
             "showResolved defaults to false")
       (t/is (= [1 2] (seq-numbers (await (.findCommentThreads page #js {:showResolved true})))))
       (t/is (= [[:get-comment-threads {:file-id file-id}]] (distinct @calls)))))
    (set! st/state prev)))

(t/deftest ^:async page-find-comment-thread-by-id
  (let [file-id            (random-uuid)
        page-id            (random-uuid)
        threads            (sample-threads page-id (random-uuid))
        [_ resolved other] threads
        page               (page/page-proxy plugin-id file-id page-id)]
    (await
     (mock/with-mocks*
       {r/check-permission (constantly true)
        rp/cmd!            (threads-rpc (atom []) threads)}
       (let [^js found (await (.findCommentThreadById page (str (:id resolved))))]
         (t/is (= (str (:id resolved)) (.-id found))
               "resolved threads are found too")
         (t/is (= (str page-id) (.-pageId found))))
       (t/is (nil? (await (.findCommentThreadById page (str (:id other)))))
             "a thread of another page is not returned")
       (t/is (nil? (await (.findCommentThreadById page (str (random-uuid))))))))))

(t/deftest ^:async page-find-comment-thread-by-id-rejects-bad-ids
  (let [page     (page/page-proxy plugin-id (random-uuid) (random-uuid))
        rejected (atom nil)]
    (await
     (mock/with-mocks*
       {r/check-permission (constantly true)
        rp/cmd!            (threads-rpc (atom []) [])}
       (await (-> (.findCommentThreadById page "not-a-uuid")
                  (.catch #(reset! rejected %))))))
    (t/is (= "Thread id not valid" @rejected))))

;; --- Penforge bot author (W26)

(def ^:private third-party-plugin-id "5a8c5a64-0000-4000-8000-000000000001")

(def ^:private ai-flags (conj cf/flags :ai))
(def ^:private no-ai-flags (disj cf/flags :ai))

(t/deftest penforge-author-only-for-the-mcp-plugin-with-the-ai-flag
  (with-redefs [cf/flags ai-flags]
    (t/is (true? (comments/penforge-author? r/mcp-plugin-id)))
    (t/is (false? (comments/penforge-author? third-party-plugin-id)))
    (t/is (false? (comments/penforge-author? plugin-id))))
  (with-redefs [cf/flags no-ai-flags]
    (t/is (false? (comments/penforge-author? r/mcp-plugin-id))
          "with the :ai flag off the MCP plugin writes as the user")))

(defn- reply-command
  "Replies on a thread as `pid` with `flags` and returns (a promise of)
  the RPC command it used."
  [flags pid]
  (let [calls  (atom [])
        thread (comments/comment-thread-proxy
                pid (random-uuid) (random-uuid) {:id (random-uuid)})]
    (-> (mock/with-mocks*
          {cf/flags           flags
           r/check-permission (constantly true)
           st/emit!           mock/noop
           rp/cmd!            (mock/stub
                               (fn [cmd params]
                                 (swap! calls conj [cmd params])
                                 (->> (rx/of {:id (random-uuid)})
                                      (rx/observe-on :async))))}
          (await (.reply thread "Done.")))
        (.then (fn [] (ffirst @calls))))))

(t/deftest ^:async thread-reply-picks-the-author-command
  (t/is (= :create-penforge-comment (await (reply-command ai-flags r/mcp-plugin-id))))
  (t/is (= :create-comment (await (reply-command ai-flags third-party-plugin-id)))
        "a third-party plugin never posts as Penforge")
  (t/is (= :create-comment (await (reply-command no-ai-flags r/mcp-plugin-id)))
        "with the :ai flag off the MCP plugin posts as the user"))

(defn- add-thread-options
  "Adds a thread on a page as `pid` with `flags` and returns (a promise
  of) the options it passed to `create-thread-on-workspace`."
  [flags pid]
  (let [options (atom ::not-called)
        page    (page/page-proxy pid (random-uuid) (random-uuid))]
    (-> (mock/with-mocks*
          {cf/flags           flags
           r/check-permission (constantly true)
           st/emit!           mock/noop
           dc/create-thread-on-workspace
           (mock/stub (fn [params _ _ opts]
                        (reset! options opts)
                        [:create-thread params]))}
          ;; The promise only settles once the thread is created, which
          ;; the stub never does: do not await it.
          (.addCommentThread page "[Audit] Low contrast" #js {:x 10 :y 20})
          nil)
        (.then (fn [] @options)))))

(t/deftest ^:async page-add-comment-thread-picks-the-author
  (t/is (= {:penforge-bot? true} (await (add-thread-options ai-flags r/mcp-plugin-id))))
  (t/is (= {:penforge-bot? false} (await (add-thread-options ai-flags third-party-plugin-id))))
  (t/is (= {:penforge-bot? false} (await (add-thread-options no-ai-flags r/mcp-plugin-id)))))

(t/deftest penforge-bot-owner
  (t/is (true? (dc/penforge-bot? (dc/get-owner {:owner-id dc/penforge-bot-id}))))
  (t/is (false? (dc/penforge-bot? (dc/get-owner {:owner-id (random-uuid)})))))
