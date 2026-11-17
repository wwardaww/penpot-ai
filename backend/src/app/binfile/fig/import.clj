;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.import
  "Import of a Figma `.fig` file as one penpot file.

  The core reads the file, stores its images, maps the document and
  persists the result in the project of the import cfg (the one
  `app.binfile.common/import-cfg` builds). It joins the transaction of
  its caller, like the cores of the other formats, so the job that runs
  it decides whether the import is kept or rolled back; the images go to
  the storage outside that transaction and are marked as touched, so
  the storage GC reclaims them when the import does not keep them.

  The answer has the ids of the files it created and the compatibility
  report of the mapping."
  (:require
   [app.binfile.common :as bfc]
   [app.binfile.fig.container :as container]
   [app.binfile.fig.map :as fig.map]
   [app.binfile.fig.tree :as tree]
   [app.binfile.migrations :as bfm]
   [app.common.exceptions :as ex]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.types.file :as ctf]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.media :as media]
   [app.storage :as sto]
   [app.storage.tmp :as tmp]
   [app.util.events :as events]
   [datoteka.fs :as fs]
   [datoteka.io :as io])
  (:import
   java.io.ByteArrayInputStream
   javax.imageio.ImageIO
   javax.imageio.ImageReader))

(def schema:report
  "The compatibility report of an import: what could not be imported as
  it was, what was imported and the fonts the file needs."
  [:map {:title "fig-import-report"}
   [:total ::sm/int]
   [:unsupported [:vector [:map
                           [:node :string]
                           [:fig-type :string]
                           [:reason :string]]]]
   [:summary [:vector [:map
                       [:fig-type :string]
                       [:reason :string]
                       [:count ::sm/int]]]]
   [:counts [:map-of :keyword ::sm/int]]
   [:fonts [:vector :string]]])

(defn- tap-progress
  [data]
  (events/tap :progress data))

(defn- header-dimensions
  "The dimensions of image bytes read from their header with the JDK
  readers (PNG, JPEG, GIF, BMP), without decoding the pixels."
  [^bytes data]
  (try
    (with-open [input (ImageIO/createImageInputStream (ByteArrayInputStream. data))]
      (let [readers (ImageIO/getImageReaders input)]
        (when (.hasNext readers)
          (let [^ImageReader reader (.next readers)]
            (try
              (.setInput reader input true true)
              {:width (.getWidth reader 0) :height (.getHeight reader 0)}
              (finally
                (.dispose reader)))))))
    (catch Exception _ nil)))

(defn- media-info
  [cfg ^bytes data mtype]
  (let [path (tmp/tempfile :prefix "penpot.fig-image.")]
    (try
      (io/write* path data)
      (media/run cfg {:cmd :info :input {:path path :mtype mtype :size (alength data)}})
      (catch Exception cause
        (l/wrn :hint "fig import: unreadable image" :mtype mtype :cause cause)
        nil)
      (finally
        (fs/delete path)))))

(defn- image-info
  "The dimensions of image bytes: from their header when the JDK reads
  the format, from the media processor otherwise (WEBP), or nil when the
  bytes are not an image."
  [cfg ^bytes data mtype]
  (or (header-dimensions data)
      (media-info cfg data mtype)))

(defn- store-images!
  "Put the images of the file in the storage and answer with what a fill
  needs of each one, by the hex of its SHA-1.

  The storage is resolved from the pool on purpose: an upload that fails
  halfway must not lose the registry of what it wrote when the import
  transaction rolls back."
  [cfg images timestamp]
  (let [storage (sto/resolve (dissoc cfg ::db/conn))
        total   (count images)]
    (->> (map-indexed vector (sort-by key images))
         (reduce (fn [out [index [hash data]]]
                   (tap-progress {:section :media :current (inc index) :total total})
                   (let [mtype (container/image-mtype data)
                         info  (when mtype (image-info cfg data mtype))]
                     (if (and info (pos? (:width info 0)) (pos? (:height info 0)))
                       (let [content (-> (sto/content data)
                                         (sto/wrap-with-hash (sto/calculate-hash data)))
                             object  (sto/put-object! storage {::sto/content       content
                                                               ::sto/deduplicate? true
                                                               ::sto/touched-at   timestamp
                                                               :content-type      mtype
                                                               :bucket            "file-media-object"})]
                         (assoc out hash {:id       (uuid/next)
                                          :media-id (:id object)
                                          :width    (:width info)
                                          :height   (:height info)
                                          :mtype    mtype
                                          :name     hash}))
                       out)))
                 {}))))

(defn- insert-media!
  [{:keys [::db/conn]} file-id media]
  (doseq [{:keys [id media-id width height mtype name]} (vals media)]
    (db/insert! conn :file-media-object
                {:id       id
                 :file-id  file-id
                 :is-local true
                 :name     name
                 :media-id media-id
                 :width    width
                 :height   height
                 :mtype    mtype}
                {::db/return-keys false})))

(defn- persist-file!
  [cfg file]
  (let [file (bfc/process-file cfg file)
        file (ctf/check-file file)]
    (bfm/register-pending-migrations! cfg file)
    (bfc/save-file! cfg file)))

(defn- file-name
  "The name of the new file: what the caller asked for, else the name
  Figma recorded, else a generic one."
  [cfg doc]
  (let [name (::bfc/name cfg)]
    (cond
      (and (string? name) (seq name)) name
      (map? name)                     (or (first (vals name)) "Figma import")
      :else                           (or (get-in doc [:meta :file_name]) "Figma import"))))

(defn- import-file*
  [{:keys [::bfc/input ::bfc/project-id ::bfc/timestamp] :as cfg}]
  (let [doc     (container/read-file input)
        _       (tap-progress {:section :manifest})
        tree    (tree/index (:message doc))
        file-id (uuid/next)
        name    (file-name cfg doc)
        media   (store-images! cfg (:images doc) timestamp)
        _       (tap-progress {:section :file})
        {:keys [file report]}
        (fig.map/map-document tree {:file-id    file-id
                                    :name       name
                                    :project-id project-id
                                    :media      (update-vals media #(select-keys % [:id :width :height :mtype :name]))})
        file    (-> file
                    (assoc :name name)
                    (assoc :project-id project-id)
                    (assoc :metadata {:generated-by "penforge/fig-import"}))]

    (bfc/configure-import-transaction cfg)
    (persist-file! cfg file)
    (insert-media! cfg file-id media)
    (bfm/apply-pending-migrations! cfg)

    (l/inf :hint "fig import: file imported"
           :file-id (str file-id)
           :fig-version (:version doc)
           :unsupported (:total report))

    {:file-ids [file-id]
     :report   report}))

(defn import-files!
  "Import the `.fig` file at `::bfc/input` into `::bfc/project-id`.

  Answers with `{:file-ids [id] :report report}`; the report lists what
  could not be imported as it was (`:unsupported`, at most
  `fig.map/max-report-entries` entries, and `:summary`, counted by node
  type and reason), what was imported (`:counts`) and the font families
  the file uses (`:fonts`)."
  [{:keys [::bfc/input] :as cfg}]
  (assert (and (uuid? (::bfc/profile-id cfg))
               (uuid? (::bfc/project-id cfg)))
          "expected valid profile-id and project-id on `cfg`")
  ;; a Penforge addition: it only exists with the `:ai` flag
  (when-not (contains? cf/flags :ai)
    (ex/raise :type :restriction
              :code :feature-disabled
              :hint "figma import is not enabled"))
  (when-not (some? input)
    (ex/raise :type :validation
              :code :missing-input
              :hint "expected the file to import"))
  (let [cfg (update cfg ::bfc/timestamp #(or % (ct/now)))]
    (binding [bfc/*state* (volatile! {:media [] :index {}})]
      (db/tx-run! cfg import-file*))))
