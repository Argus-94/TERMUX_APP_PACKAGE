package expo.modules.pdfextractor

import android.content.Context
import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.Writer

/** Local, bounded PDF text extraction. User paths and parser exceptions are never logged or returned. */
class PdfExtractorModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is null" }

  override fun definition() = ModuleDefinition {
    Name("PdfExtractor")

    OnCreate {
      try { PDFBoxResourceLoader.init(context) } catch (_: Exception) { /* extraction will return a generic error */ }
    }

    AsyncFunction("extractText") { filePath: String, password: String?, promise: Promise ->
      try {
        val text = withPdfDocument(filePath, password) { document ->
          val writer = BoundedPdfWriter(MAX_OUTPUT_CHARS)
          PDFTextStripper().apply {
            sortByPosition = true
            addMoreFormatting = false
            startPage = 1
            endPage = document.numberOfPages
          }.writeText(document, writer)
          writer.value()
        }
        promise.resolve(text)
      } catch (error: InvalidPasswordException) {
        promise.reject(passwordCodedException(password, error))
      } catch (error: PdfInputTooLargeException) {
        promise.reject("PDF_INPUT_LIMIT", "PDF exceeds the safe input size limit", null)
      } catch (error: PdfPageLimitException) {
        promise.reject("PDF_PAGE_LIMIT", "PDF exceeds the safe page-count limit", null)
      } catch (_: Exception) {
        promise.reject("PDF_EXTRACTION_ERROR", "PDF could not be safely extracted", null)
      }
    }

    Function("isAvailable") { true }

    AsyncFunction("getPageCount") { filePath: String, password: String?, promise: Promise ->
      try {
        promise.resolve(withPdfDocument(filePath, password) { it.numberOfPages })
      } catch (error: InvalidPasswordException) {
        promise.reject(passwordCodedException(password, error))
      } catch (error: PdfInputTooLargeException) {
        promise.reject("PDF_INPUT_LIMIT", "PDF exceeds the safe input size limit", null)
      } catch (error: PdfPageLimitException) {
        promise.reject("PDF_PAGE_LIMIT", "PDF exceeds the safe page-count limit", null)
      } catch (_: Exception) {
        promise.reject("PDF_ERROR", "PDF could not be safely inspected", null)
      }
    }

    AsyncFunction("extractTextFromPage") { filePath: String, pageNumber: Int, password: String?, promise: Promise ->
      try {
        val text = withPdfDocument(filePath, password) { document ->
          if (pageNumber < 1 || pageNumber > document.numberOfPages) throw PdfPageRangeException()
          val writer = BoundedPdfWriter(MAX_OUTPUT_CHARS)
          PDFTextStripper().apply {
            sortByPosition = true
            startPage = pageNumber
            endPage = pageNumber
          }.writeText(document, writer)
          writer.value()
        }
        promise.resolve(text)
      } catch (error: InvalidPasswordException) {
        promise.reject(passwordCodedException(password, error))
      } catch (error: PdfInputTooLargeException) {
        promise.reject("PDF_INPUT_LIMIT", "PDF exceeds the safe input size limit", null)
      } catch (error: PdfPageLimitException) {
        promise.reject("PDF_PAGE_LIMIT", "PDF exceeds the safe page-count limit", null)
      } catch (error: PdfPageRangeException) {
        promise.reject("PDF_PAGE_RANGE", "Requested page is outside the safe PDF page range", null)
      } catch (_: Exception) {
        promise.reject("PDF_EXTRACTION_ERROR", "PDF page could not be safely extracted", null)
      }
    }

    AsyncFunction("isPasswordProtected") { filePath: String, promise: Promise ->
      try {
        withPdfDocument(filePath, "") { false }
        promise.resolve(false)
      } catch (_: InvalidPasswordException) {
        promise.resolve(true)
      } catch (error: PdfInputTooLargeException) {
        promise.reject("PDF_INPUT_LIMIT", "PDF exceeds the safe input size limit", null)
      } catch (error: PdfPageLimitException) {
        promise.reject("PDF_PAGE_LIMIT", "PDF exceeds the safe page-count limit", null)
      } catch (_: Exception) {
        promise.reject("PDF_LOAD_ERROR", "PDF could not be safely inspected", null)
      }
    }
  }

  private fun passwordCodedException(password: String?, cause: Throwable): CodedException =
    if (password.isNullOrEmpty()) CodedException("PASSWORD_REQUIRED", "PDF requires a password", cause)
    else CodedException("INCORRECT_PASSWORD", "Provided password is incorrect", cause)

  private fun <T> withPdfDocument(filePath: String, password: String?, block: (PDDocument) -> T): T {
    val boundedFile = copyPdfToPrivateCache(filePath)
    try {
      val memory = MemoryUsageSetting.setupMixed(MAX_PDF_MAIN_MEMORY_BYTES, MAX_PDF_STORAGE_BYTES)
        .setTempDir(context.cacheDir)
      PDDocument.load(boundedFile, password ?: "", memory).use { document ->
        if (document.numberOfPages > MAX_PDF_PAGES) throw PdfPageLimitException()
        return block(document)
      }
    } finally {
      boundedFile.delete()
    }
  }

  private fun copyPdfToPrivateCache(filePath: String): File {
    if (filePath.isBlank() || filePath.length > MAX_URI_LENGTH) throw PdfInvalidInputException()
    val temp = File.createTempFile("aib-pdf-", ".pdf", context.cacheDir)
    try {
      openInputStream(filePath).buffered().use { input ->
        FileOutputStream(temp).buffered().use { output ->
          val prefix = ByteArray(PDF_HEADER.size)
          var prefixBytes = 0
          while (prefixBytes < prefix.size) {
            val read = input.read(prefix, prefixBytes, prefix.size - prefixBytes)
            if (read < 0) break
            if (read > 0) prefixBytes += read
          }
          if (prefixBytes != prefix.size || !prefix.contentEquals(PDF_HEADER)) throw PdfInvalidInputException()
          output.write(prefix)
          var total = prefix.size.toLong()
          val buffer = ByteArray(COPY_CHUNK_BYTES)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) continue
            if (read.toLong() > MAX_PDF_INPUT_BYTES - total) throw PdfInputTooLargeException()
            output.write(buffer, 0, read)
            total += read
          }
        }
      }
      return temp
    } catch (error: Exception) {
      temp.delete()
      throw error
    }
  }

  private fun openInputStream(filePath: String): InputStream {
    return when {
      filePath.startsWith("content://", ignoreCase = true) -> {
        context.contentResolver.openInputStream(Uri.parse(filePath)) ?: throw PdfInvalidInputException()
      }
      filePath.startsWith("file://", ignoreCase = true) -> {
        val path = Uri.parse(filePath).path ?: throw PdfInvalidInputException()
        File(path).inputStream()
      }
      filePath.startsWith("/") -> File(filePath).inputStream()
      else -> throw PdfInvalidInputException()
    }
  }

  private class BoundedPdfWriter(private val limit: Int) : Writer() {
    private val output = StringBuilder()
    private var truncated = false

    override fun write(buffer: CharArray, offset: Int, length: Int) {
      if (offset < 0 || length < 0 || offset > buffer.size - length) throw IndexOutOfBoundsException()
      val remaining = limit - output.length
      val accepted = length.coerceAtMost(remaining.coerceAtLeast(0))
      if (accepted > 0) output.append(buffer, offset, accepted)
      if (accepted < length) truncated = true
    }

    override fun flush() = Unit
    override fun close() = Unit

    fun value(): String = output.toString() + if (truncated) "\n[Text truncated at the safe extraction limit.]" else ""
  }

  private class PdfInputTooLargeException : Exception()
  private class PdfPageLimitException : Exception()
  private class PdfPageRangeException : Exception()
  private class PdfInvalidInputException : Exception()

  private companion object {
    const val MAX_URI_LENGTH = 4096
    const val MAX_PDF_INPUT_BYTES = 20L * 1024L * 1024L
    const val MAX_PDF_MAIN_MEMORY_BYTES = 16L * 1024L * 1024L
    const val MAX_PDF_STORAGE_BYTES = 128L * 1024L * 1024L
    const val MAX_PDF_PAGES = 300
    const val MAX_OUTPUT_CHARS = 200_000
    const val COPY_CHUNK_BYTES = 32 * 1024
    val PDF_HEADER = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d)
  }
}
