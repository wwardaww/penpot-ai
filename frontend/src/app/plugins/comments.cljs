;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.plugins.comments
  (:require
   [app.common.data :as d]
   [app.common.files.helpers :as cfh]
   [app.common.geom.point :as gpt]
   [app.common.geom.shapes :as gsh]
   [app.common.schema :as sm]
   [app.common.types.shape-tree :as ctst]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.main.data.comments :as dc]
   [app.main.data.workspace.comments :as dwc]
   [app.main.repo :as rp]
   [app.main.store :as st]
   [app.plugins.format :as format]
   [app.plugins.parser :as parser]
   [app.plugins.register :as r]
   [app.plugins.shape :as shape]
   [app.plugins.system-events :as se]
   [app.plugins.user :as user]
   [app.plugins.utils :as u]
   [app.util.object :as obj]
   [beicon.v2.core :as rx]))

(defn- clips-content?
  [shape]
  (and (cfh/frame-shape? shape)
       (not (cfh/root? shape))
       (not (:show-content shape))))

(defn- get-top-shape-id-at
  "Returns the id of the top-most visible shape under `position` inside the
  subtree of `shape` (the shape included), or nil. Children are visited from
  top to bottom, hidden subtrees are skipped and boards that clip their
  content only take points inside them. Groups have no paint of their own and
  are never returned; boolean shapes are returned whole."
  [objects shape position]
  (when-not (:hidden shape)
    (let [inside? (and (not (cfh/root? shape))
                       (gsh/has-point? shape position))]
      (when (or inside? (not (clips-content? shape)))
        (if (cfh/bool-shape? shape)
          (when inside? (:id shape))
          (or (->> (:shapes shape)
                   (keep (d/getf objects))
                   (ctst/sort-z-index-objects objects)
                   (some #(get-top-shape-id-at objects % position)))
              (when (and inside? (not (cfh/group-shape? shape)))
                (:id shape))))))))

(defn- reachable-at?
  "Checks that no ancestor of `shape` hides it or clips it away at `position`."
  [objects shape position]
  (->> (cfh/get-parent-ids objects (:id shape))
       (keep (d/getf objects))
       (not-any? (fn [ancestor]
                   (or (:hidden ancestor)
                       (and (clips-content? ancestor)
                            (not (gsh/has-point? ancestor position))))))))

(defn get-thread-node-id
  "Returns the id of the deepest visible shape under the thread `position`
  (absolute point) in the page `objects`. The search runs inside the thread
  board `frame-id` when that board still exists and holds the point, else in
  the whole page. Returns nil when no shape is there."
  [objects frame-id position]
  (let [position (gpt/point position)
        board    (get objects frame-id)
        start    (if (and (some? board)
                          (not (cfh/root? board))
                          (not (:hidden board))
                          (gsh/has-point? board position)
                          (reachable-at? objects board position))
                   board
                   (get objects uuid/zero))]
    (when (some? start)
      (get-top-shape-id-at objects start position))))

(defn penforge-author?
  "True when the comments `plugin-id` writes are authored by the Penforge
  bot: only the bundled MCP plugin (the Penforge AI) with the `:ai` flag
  on. Third-party plugins always write as the user."
  [plugin-id]
  (and (contains? cf/flags :ai)
       (= plugin-id r/mcp-plugin-id)))

(defn comment-proxy? [p]
  (obj/type-of? p "CommentProxy"))

(defn comment-proxy
  [plugin-id file-id page-id thread-id data]
  (let [data* (atom data)]
    (obj/reify {:name "CommentProxy"}
      ;; Private properties
      :$plugin {:enumerable false :get (fn [] plugin-id)}
      :$file {:enumerable false :get (fn [] file-id)}
      :$page {:enumerable false :get (fn [] page-id)}
      :$thread {:enumerable false :get (fn [] thread-id)}
      :$id {:enumerable false :get (fn [] (:id data))}

      ;; Public properties
      :id {:get #(format/format-id (:id data))}

      ;; FIXME: inconsistent with comment-thread: owner
      :user
      {:get #(when (r/check-permission plugin-id "user:read")
               (->> (dc/get-owner data)
                    (user/user-proxy plugin-id)))}

      :owner
      {:get #(when (r/check-permission plugin-id "user:read")
               (->> (dc/get-owner data)
                    (user/user-proxy plugin-id)))}

      :date
      {:get
       (fn [] (:created-at data))}

      :content
      {:get
       (fn [] (:content @data*))

       :set
       (fn [content]
         (let [profile (:profile @st/state)]
           (cond
             (not (dc/valid-comment-content? content))
             (u/not-valid plugin-id :content "Not valid")

             (not= (:id profile) (:owner-id data))
             (u/not-valid plugin-id :content "Cannot change content from another user's comments")

             (not (r/check-permission plugin-id "comment:write"))
             (u/not-valid plugin-id :content "Plugin doesn't have 'comment:write' permission")

             :else
             (->> (rp/cmd! :update-comment {:id (:id data) :content content})
                  (rx/tap #(st/emit! (dc/retrieve-comment-threads file-id)))
                  (rx/subs!
                   (fn []
                     (st/emit! (se/event plugin-id "update-comment"
                                         :thread-id thread-id
                                         :id (:id data)
                                         :content-size (count content)))
                     (swap! data* assoc :content content)))))))}

      ;; Public methods
      :remove
      (fn []
        (js/Promise.
         (fn [resolve reject]
           (cond
             (not (r/check-permission plugin-id "comment:write"))
             (do
               (u/not-valid plugin-id :remove "Plugin doesn't have 'comment:write' permission")
               (reject "Plugin doesn't have 'comment:write' permission"))

             :else
             (->> (rp/cmd! :delete-comment {:id (:id data)})
                  (rx/tap #(st/emit! (dc/retrieve-comment-threads file-id)))
                  (rx/subs!
                   (fn []
                     (st/emit! (se/event plugin-id "update-comment" :thread-id thread-id))
                     (resolve))
                   reject)))))))))

(defn comment-thread-proxy? [p]
  (obj/type-of? p "CommentThreadProxy"))

(defn comment-thread-proxy
  [plugin-id file-id page-id data]
  (let [data* (atom data)]
    (obj/reify {:name "CommentThreadProxy"}
      :$plugin {:enumerable false :get (fn [] plugin-id)}
      :$file {:enumerable false :get (fn [] file-id)}
      :$page {:enumerable false :get (fn [] page-id)}
      :$id {:enumerable false :get (fn [] (:id data))}

      :page {:enumerable false :get #(u/locate-page file-id page-id)}
      :id {:get #(format/format-id (:id data))}
      :pageId {:get #(format/format-id page-id)}
      :seqNumber {:get #(:seqn data)}
      :board {:get #(shape/shape-proxy plugin-id file-id page-id (:frame-id data))}

      :nodeId
      {:get
       (fn []
         (let [{:keys [frame-id position]} @data*
               objects (u/locate-objects file-id page-id)]
           (when (and (some? objects) (some? position))
             (some-> (get-thread-node-id objects frame-id position)
                     (format/format-id)))))}

      :owner
      {:get #(when (r/check-permission plugin-id "user:read")
               (->> (dc/get-owner data)
                    (user/user-proxy plugin-id)))}

      :position
      {:get
       (fn []
         (format/format-point (:position @data*)))

       :set
       (fn [position]
         (let [position (parser/parse-point position)]
           (cond
             (or (not (sm/valid-safe-number? (:x position)))
                 (not (sm/valid-safe-number? (:y position))))
             (u/not-valid plugin-id :position "Not valid point")

             (not (r/check-permission plugin-id "comment:write"))
             (u/not-valid plugin-id :position "Plugin doesn't have 'comment:write' permission")

             (not (u/page-active? page-id))
             (u/not-valid plugin-id :position "Cannot modify a page that is not currently active")

             :else
             (do (st/emit! (dwc/update-comment-thread-position @data* [(:x position) (:y position)]))
                 (swap! data* assoc :position (gpt/point position))))))}

      :resolved
      {:get
       (fn [] (:is-resolved @data*))

       :set
       (fn [is-resolved]
         (cond
           (not (boolean? is-resolved))
           (u/not-valid plugin-id :resolved "Not a boolean type")

           (not (r/check-permission plugin-id "comment:write"))
           (u/not-valid plugin-id :resolved "Plugin doesn't have 'comment:write' permission")

           :else
           (do (st/emit! (-> (dc/update-comment-thread (assoc @data* :is-resolved is-resolved))
                             (se/add-event plugin-id)))
               (swap! data* assoc :is-resolved is-resolved))))}

      :findComments
      (fn []
        (js/Promise.
         (fn [resolve reject]
           (cond
             (not (r/check-permission plugin-id "comment:read"))
             (do
               (u/not-valid plugin-id :findComments "Plugin doesn't have 'comment:read' permission")
               (reject "Plugin doesn't have 'comment:read' permission"))

             :else
             (->> (rp/cmd! :get-comments {:thread-id (:id data)})
                  (rx/subs!
                   (fn [comments]
                     (resolve
                      (format/format-array
                       #(comment-proxy plugin-id file-id page-id (:id data) %) comments)))
                   reject))))))

      :reply
      (fn [content]
        (cond
          (not (r/check-permission plugin-id "comment:write"))
          (u/not-valid plugin-id :reply "Plugin doesn't have 'comment:write' permission")

          (not (dc/valid-comment-content? content))
          (u/not-valid plugin-id :reply "Not valid")

          :else
          (js/Promise.
           (fn [resolve reject]
             (->> (rp/cmd! (if (penforge-author? plugin-id)
                             :create-penforge-comment
                             :create-comment)
                           {:thread-id (:id data) :content content})
                  (rx/subs!
                   (fn [result]
                     (st/emit! (se/event plugin-id "create-comment"
                                         :thread-id (:id data)
                                         :file-id file-id
                                         :content-size (count content)))
                     (resolve (comment-proxy plugin-id file-id page-id (:id data) result))) reject))))))

      :remove
      (fn []
        (let [profile (:profile @st/state)]
          (cond
            (not (r/check-permission plugin-id "comment:write"))
            (u/not-valid plugin-id :remove "Plugin doesn't have 'comment:write' permission")

            (not= (:id profile) (:owner-id data))
            (u/not-valid plugin-id :remove "Cannot change content from another user's comments")

            :else
            (js/Promise.
             (fn [resolve]
               (st/emit! (-> (dc/delete-comment-thread-on-workspace {:id (:id data)} #(resolve))
                             (se/add-event plugin-id)))))))))))
