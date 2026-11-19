import com.aspose.tasks.License;
import com.aspose.tasks.Project;
import com.aspose.tasks.SaveFileFormat;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Turns a Microsoft Project XML plan into a Microsoft Project file (.mpp), for
 * EPM's Tasks → Export (backend/src/domain/ms-project.ts). Built into the
 * backend image with Aspose.Tasks for Java (backend/Dockerfile, plans stage).
 *
 *   java -cp aspose-tasks.jar:epm-mpp-writer.jar EpmMppWriter plan.xml plan.mpp
 *   java -cp aspose-tasks.jar:epm-mpp-writer.jar EpmMppWriter --check
 *
 * .mpp is Microsoft's closed format: MPXJ, which reads it for the import, does
 * not write it, and Aspose.Tasks writes it only with a licence. Without one it
 * refuses ("not allowed in evaluation mode"), and an unlicensed copy moves
 * every date it writes to the year 2000. So nothing is written without a
 * licence that loads.
 *
 * The licence is the .lic file Aspose issues, in the EPM_ASPOSE_TASKS_LICENSE
 * environment variable: base64-encoded, as a secret in .env.prod; or as the
 * file's own XML, which is what the backend hands over when the secret comes
 * from a file (EPM_ASPOSE_TASKS_LICENSE_FILE).
 *
 * Exit codes: 0 written (or, with --check, licensed); 2 wrong arguments;
 * 3 no licence; 4 the licence did not load; 5 the plan could not be read or
 * written. The reason is the last line on standard error.
 */
public final class EpmMppWriter {
  private EpmMppWriter() {}

  public static void main(String[] args) {
    String licence = System.getenv("EPM_ASPOSE_TASKS_LICENSE");
    if (licence == null || licence.trim().isEmpty()) {
      fail(3, "No Aspose.Tasks licence is set (EPM_ASPOSE_TASKS_LICENSE).");
    }
    try {
      String value = licence.trim();
      byte[] bytes = value.startsWith("<")
          ? value.getBytes(StandardCharsets.UTF_8)
          : Base64.getMimeDecoder().decode(value);
      new License().setLicense(new ByteArrayInputStream(bytes));
    } catch (Throwable error) {
      fail(4, "The Aspose.Tasks licence did not load: " + error.getMessage());
    }
    if (args.length == 1 && "--check".equals(args[0])) {
      System.out.println("licensed");
      return;
    }
    if (args.length != 2) fail(2, "Usage: EpmMppWriter <plan.xml> <plan.mpp> | --check");
    try {
      Project project = new Project(args[0]);
      project.save(args[1], SaveFileFormat.Mpp);
    } catch (Throwable error) {
      fail(5, "The plan could not be written as .mpp: " + error);
    }
  }

  private static void fail(int code, String reason) {
    System.err.println(reason);
    System.exit(code);
  }
}
