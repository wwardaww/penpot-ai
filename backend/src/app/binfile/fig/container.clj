;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.binfile.fig.container
  "Reading a Figma `.fig` file: the ZIP that holds `canvas.fig`,
  `meta.json` and the images, or a bare `canvas.fig`.

  `canvas.fig` is an eight byte prelude (`fig-kiwi` for design files),
  a little endian uint32 version and a list of chunks, each one a little
  endian uint32 length and its bytes. The first chunk is the compressed
  Kiwi schema and the second the compressed message. A chunk is
  compressed with zstd, zlib or raw deflate, told apart by its first
  bytes.

  Every decompression is bounded, and so are the number of entries of
  the ZIP and the size of each image, so a hostile file fails with a
  validation error instead of filling the disk or the memory."
  (:require
   [app.binfile.fig.kiwi :as kiwi]
   [app.common.exceptions :as ex]
   [app.common.json :as json]
   [cuerdas.core :as str]
   [datoteka.fs :as fs])
  (:import
   com.github.luben.zstd.ZstdInputStream
   java.io.ByteArrayInputStream
   java.io.ByteArrayOutputStream
   java.io.InputStream
   java.util.zip.Inflater
   java.util.zip.InflaterInputStream
   java.util.zip.ZipEntry
   java.util.zip.ZipFile))

(set! *warn-on-reflection* true)

(def default-limits
  "The bounds of a read. A big real file decompresses its message to tens
  of megabytes; images are stored once each."
  {:max-chunk-size    (* 512 1024 1024)
   :max-image-size    (* 64 1024 1024)
   :max-images-size   (* 1024 1024 1024)
   :max-zip-entries   20000})

(def preludes
  "The kinds of payload by their prelude. Only design files are
  imported; the other kinds are recognized to answer with a precise
  error."
  {"fig-kiwi" :design
   "fig-jam." :figjam
   "fig-deck" :slides})

(defn- invalid
  [code hint & {:as data}]
  (ex/raise :type :validation
            :code code
            :hint hint
            ::data data))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; DECOMPRESSION
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- read-bounded
  "All the bytes of `input`, refusing more than `limit`."
  ^bytes [^InputStream input limit]
  (with-open [input input]
    (let [out (ByteArrayOutputStream.)
          buf (byte-array 65536)]
      (loop [total 0]
        (let [n (.read input buf)]
          (if (neg? n)
            (.toByteArray out)
            (let [total (+ total n)]
              (when (> total limit)
                (invalid :fig-file-too-large "a chunk of the file decompresses beyond the limit"
                         :limit limit))
              (.write out buf 0 n)
              (recur total))))))))

(defn compression
  "The compression of a chunk, by its first bytes."
  [^bytes data]
  (let [b (fn [i] (when (< i (alength data)) (bit-and (aget data i) 0xff)))]
    (cond
      (and (= 0x28 (b 0)) (= 0xb5 (b 1)) (= 0x2f (b 2)) (= 0xfd (b 3)))
      :zstd

      (and (= 0x78 (b 0))
           (some? (b 1))
           (zero? (mod (+ (* 256 (b 0)) (b 1)) 31)))
      :zlib

      :else
      :deflate)))

(defn decompress
  "The bytes of a chunk, decompressed with what its header says."
  ^bytes [^bytes data limit]
  (try
    (case (compression data)
      :zstd    (read-bounded (ZstdInputStream. (ByteArrayInputStream. data)) limit)
      :zlib    (read-bounded (InflaterInputStream. (ByteArrayInputStream. data) (Inflater. false)) limit)
      :deflate (read-bounded (InflaterInputStream. (ByteArrayInputStream. data) (Inflater. true)) limit))
    (catch java.io.IOException cause
      (invalid :invalid-fig-file "a chunk of the file cannot be decompressed"
               :cause (ex-message cause)))
    (catch java.util.zip.ZipException cause
      (invalid :invalid-fig-file "a chunk of the file cannot be decompressed"
               :cause (ex-message cause)))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; CANVAS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- read-prelude
  [^bytes data]
  (when (>= (alength data) 12)
    (String. data 0 8 java.nio.charset.StandardCharsets/ISO_8859_1)))

(defn read-chunks
  "The prelude, version and raw chunks of a `canvas.fig` payload."
  [^bytes data]
  (let [prelude (read-prelude data)
        kind    (get preludes prelude)]
    (when-not kind
      (invalid :invalid-fig-file "not a figma file: unknown prelude"))
    (let [bb (doto (kiwi/buffer data) (.position 8))
          version (bit-and (.getInt bb) 0xffffffff)]
      (loop [chunks []]
        (if (< (.remaining bb) 4)
          {:prelude prelude :kind kind :version version :chunks chunks}
          (let [n (bit-and (.getInt bb) 0xffffffff)]
            (when (> n (.remaining bb))
              (invalid :invalid-fig-file "truncated chunk" :length n))
            (let [chunk (byte-array n)]
              (.get bb chunk)
              (recur (conj chunks chunk)))))))))

(defn decode-canvas
  "Decode a `canvas.fig` payload: its schema and its message."
  ([data] (decode-canvas data default-limits))
  ([^bytes data {:keys [max-chunk-size]}]
   (let [{:keys [chunks kind] :as head} (read-chunks data)]
     (when-not (= :design kind)
       (ex/raise :type :validation
                 :code :unsupported-fig-kind
                 :hint (str "only figma design files can be imported, this one is " (name kind))
                 :kind kind))
     (when (< (count chunks) 2)
       (invalid :invalid-fig-file "the file has no schema or no data chunk"))
     (let [schema   (-> (nth chunks 0) (decompress max-chunk-size) (kiwi/decode-schema))
           decoders (kiwi/compile-schema schema)
           message  (->> (decompress (nth chunks 1) max-chunk-size)
                         (kiwi/decode-message decoders "Message"))]
       (-> head
           (dissoc :chunks)
           (assoc :schema schema)
           (assoc :message message))))))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; FILE
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn file-format
  "What a file is by its first bytes: `:zip`, `:canvas` or nil."
  [path]
  (with-open [input (java.io.FileInputStream. (fs/file path))]
    (let [buf (byte-array 8)
          n   (.read input buf)]
      (cond
        (and (>= n 4)
             (= 0x50 (aget buf 0)) (= 0x4b (aget buf 1))
             (= 0x03 (aget buf 2)) (= 0x04 (aget buf 3)))
        :zip

        (and (= n 8) (contains? preludes (String. buf java.nio.charset.StandardCharsets/ISO_8859_1)))
        :canvas

        :else
        nil))))

(defn- entry-bytes
  ^bytes [^ZipFile zip ^ZipEntry entry limit]
  (read-bounded (.getInputStream zip entry) limit))

(def ^:private image-entry-re
  #"^images/([0-9a-fA-F]{40})$")

(defn image-mtype
  "The media type of image bytes by their magic number, or nil when the
  bytes are not an image penpot accepts."
  [^bytes data]
  (let [b (fn [i] (when (< i (alength data)) (bit-and (aget data i) 0xff)))]
    (cond
      (and (= 0x89 (b 0)) (= 0x50 (b 1)) (= 0x4e (b 2)) (= 0x47 (b 3))) "image/png"
      (and (= 0xff (b 0)) (= 0xd8 (b 1)) (= 0xff (b 2)))                 "image/jpeg"
      (and (= 0x47 (b 0)) (= 0x49 (b 1)) (= 0x46 (b 2)))                 "image/gif"
      (and (= 0x52 (b 0)) (= 0x49 (b 1)) (= 0x46 (b 2)) (= 0x46 (b 3))
           (= 0x57 (b 8)) (= 0x45 (b 9)) (= 0x42 (b 10)) (= 0x50 (b 11))) "image/webp"
      :else nil)))

(defn- read-zip
  [path {:keys [max-chunk-size max-image-size max-images-size max-zip-entries] :as limits}]
  (with-open [zip (ZipFile. (fs/file path))]
    (when (> (.size zip) max-zip-entries)
      (invalid :invalid-fig-file "the file has too many entries" :entries (.size zip)))
    (let [canvas (or (.getEntry zip "canvas.fig")
                     (invalid :invalid-fig-file "not a figma file: canvas.fig is missing"))
          meta   (some-> (.getEntry zip "meta.json")
                         (as-> entry (entry-bytes zip entry (* 1024 1024)))
                         (String. java.nio.charset.StandardCharsets/UTF_8)
                         (as-> s (ex/ignoring (json/decode s :key-fn keyword))))
          images (loop [entries (enumeration-seq (.entries zip))
                        total   0
                        images  {}]
                   (if-let [^ZipEntry entry (first entries)]
                     (if-let [[_ hash] (re-matches image-entry-re (.getName entry))]
                       (let [data  (entry-bytes zip entry max-image-size)
                             total (+ total (alength data))]
                         (when (> total max-images-size)
                           (invalid :fig-file-too-large "the images of the file exceed the limit"))
                         (recur (rest entries) total (assoc images (str/lower hash) data)))
                       (recur (rest entries) total images))
                     images))]
      (-> (decode-canvas (entry-bytes zip canvas max-chunk-size) limits)
          (assoc :meta meta)
          (assoc :images images)))))

(defn read-file
  "Read a `.fig` file from `path`: the decoded schema and message, the
  `meta.json` (when there is one) and the images by the lowercase hex of
  their SHA-1."
  ([path] (read-file path default-limits))
  ([path limits]
   (let [limits (merge default-limits limits)]
     (case (file-format path)
       :zip    (read-zip path limits)
       :canvas (-> (decode-canvas (java.nio.file.Files/readAllBytes (fs/path path)) limits)
                   (assoc :images {}))
       (invalid :invalid-fig-file "not a figma file")))))
