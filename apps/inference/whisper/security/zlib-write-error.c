/* Regressions for caller-buffer lifetime after a failed gzwrite(),
 * CVE-2026-76844 and CVE-2026-85091.
 * The input buffer belongs to the caller and may be released after the call.
 * Use mmap/munmap so retaining it causes a deterministic invalid access on retry.
 */
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <zlib.h>

int main(void) {
    const size_t size = 131072;
    void *input = mmap(NULL, size, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    assert(input != MAP_FAILED);
    memset(input, 'x', size);
    int fd = open("/dev/full", O_WRONLY);
    assert(fd >= 0);
    gzFile file = gzdopen(fd, "wb0");
    assert(file != NULL);
    assert(gzbuffer(file, 64) == 0);
    assert(gzwrite(file, input, (unsigned)size) == 0);
    int error = 0;
    gzerror(file, &error);
    assert(error == Z_ERRNO);
    assert(munmap(input, size) == 0);
    gzclearerr(file);
    /* A retry may buffer bytes or report the same I/O error; it must be safe. */
    const char retry[] = "retry after write failure";
    (void)gzprintf(file, "%s", retry);
    (void)gzwrite(file, retry, sizeof(retry));
    (void)gzflush(file, Z_SYNC_FLUSH);
    (void)gzclose(file);
    puts("gzwrite error/retry preserved caller-buffer lifetime");
    return 0;
}
