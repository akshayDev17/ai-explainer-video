#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>
#include "net.h"

/* open a TCP connection to localhost: the sandbox denies it */
int ping(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { perror("socket"); return -1; }
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int rc = connect(fd, (struct sockaddr *)&a, sizeof a);
  if (rc < 0) perror("connect");
  close(fd);
  return rc;
}
