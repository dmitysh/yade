#include <unistd.h>

int main(void) {
    char buffer[4096];
    ssize_t size;
    while ((size = read(STDIN_FILENO, buffer, sizeof buffer)) > 0) {
        for (ssize_t offset = 0; offset < size;) {
            ssize_t written = write(STDOUT_FILENO, buffer + offset, size - offset);
            if (written <= 0) return 1;
            offset += written;
        }
    }
    return size < 0;
}
